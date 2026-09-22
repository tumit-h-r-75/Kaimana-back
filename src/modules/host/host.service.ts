// Service for "host a contest" requests: a user asks to run their own
// contests, and an admin either approves (promoting them to the "guest" role,
// which can manage only its own contests) or rejects the request.

import { FilterQuery, Types } from "mongoose";
import { HostRequestModel, type HostRequestStatus, type IHostRequest } from "../../models/HostRequest.model.js";
import { UserModel, type IUser } from "../../models/User.model.js";
import { AppError } from "../../utils/errors.js";
import { notificationService } from "../notification/notification.service.js";

// Same loose `mongoose.models.X || model(...)` union as every other model, so
// .lean() results need an explicit cast (see contest.service.ts).
type LeanHostRequest = IHostRequest & { _id: Types.ObjectId };
type LeanRequestUser = Pick<IUser, "name" | "email" | "role"> & { _id: Types.ObjectId };

export interface HostRequestDto {
  id: string;
  status: HostRequestStatus;
  organization: string;
  contestTitle: string;
  contestDescription: string;
  proposedStartTime: string | null;
  proposedEndTime: string | null;
  expectedParticipants: number | null;
  contactEmail: string;
  message: string;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  // Only on the admin endpoints.
  user?: { id: string; name: string; email: string; role: IUser["role"] };
}

const REQUEST_STATUSES: HostRequestStatus[] = ["pending", "approved", "rejected"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PENDING_CONFLICT_MESSAGE = "You already have a pending request.";

const isDuplicateKeyError = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
};

// Every field is type-checked before use: req.body is whatever JSON the
// client sent (or undefined when there is no body at all), so a wrong type
// has to be a clear 400 rather than a TypeError surfacing as a 500.
const toBodyObject = (payload: unknown) => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AppError("Request body must be a JSON object.", 400);
  }
  return payload as Record<string, unknown>;
};

// Optional inputs treat undefined, null and a blank string alike as "not
// provided", so a form that sends every field (empty ones included) validates
// the same as one that omits them.
const isBlank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const requiredText = (value: unknown, field: string, min: number, max: number) => {
  if (typeof value !== "string" || !value.trim()) throw new AppError(`${field} is required.`, 400);
  const text = value.trim();
  if (text.length < min || text.length > max) throw new AppError(`${field} must be between ${min} and ${max} characters.`, 400);
  return text;
};

const optionalText = (value: unknown, field: string, max: number) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new AppError(`${field} must be a string.`, 400);
  const text = value.trim();
  if (text.length > max) throw new AppError(`${field} must be at most ${max} characters.`, 400);
  return text;
};

const optionalDate = (value: unknown, field: string) => {
  if (isBlank(value)) return undefined;
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new AppError(`${field} must be a valid date.`, 400);
  return date;
};

const toIsoOrNull = (value?: Date | null) => (value ? new Date(value).toISOString() : null);

// Built by hand rather than through toJSON so the API shape stays fixed no
// matter what gets added to the schema later.
const toHostRequestDto = (request: LeanHostRequest, user?: LeanRequestUser | null): HostRequestDto => {
  const dto: HostRequestDto = {
    id: String(request._id),
    status: request.status,
    organization: request.organization ?? "",
    contestTitle: request.contestTitle,
    contestDescription: request.contestDescription,
    proposedStartTime: toIsoOrNull(request.proposedStartTime),
    proposedEndTime: toIsoOrNull(request.proposedEndTime),
    expectedParticipants: request.expectedParticipants ?? null,
    contactEmail: request.contactEmail ?? "",
    message: request.message ?? "",
    reviewNote: request.reviewNote ?? null,
    reviewedAt: toIsoOrNull(request.reviewedAt),
    createdAt: new Date(request.createdAt).toISOString(),
  };
  if (user) dto.user = { id: String(user._id), name: user.name, email: user.email, role: user.role };
  return dto;
};

const createRequest = async (userId: string, payload: unknown) => {
  const body = toBodyObject(payload);

  const contestTitle = requiredText(body.contestTitle, "contestTitle", 3, 120);
  const contestDescription = requiredText(body.contestDescription, "contestDescription", 10, 2000);
  const organization = optionalText(body.organization, "organization", 120);
  const message = optionalText(body.message, "message", 2000);

  const proposedStartTime = optionalDate(body.proposedStartTime, "proposedStartTime");
  const proposedEndTime = optionalDate(body.proposedEndTime, "proposedEndTime");
  if (proposedStartTime && proposedEndTime && proposedEndTime <= proposedStartTime) {
    throw new AppError("proposedEndTime must be after proposedStartTime.", 400);
  }

  let expectedParticipants: number | undefined;
  if (!isBlank(body.expectedParticipants)) {
    const value = body.expectedParticipants;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100000) {
      throw new AppError("expectedParticipants must be a whole number between 1 and 100000.", 400);
    }
    expectedParticipants = value;
  }

  let contactEmail: string | undefined;
  if (!isBlank(body.contactEmail)) {
    if (typeof body.contactEmail !== "string") throw new AppError("contactEmail must be a valid email address.", 400);
    contactEmail = body.contactEmail.trim().toLowerCase();
    if (contactEmail.length > 254 || !EMAIL_PATTERN.test(contactEmail)) {
      throw new AppError("contactEmail must be a valid email address.", 400);
    }
  }

  const user = (await UserModel.findById(userId).select("email role").lean()) as unknown as Pick<IUser, "email" | "role"> | null;
  if (!user) throw new AppError("User not found.", 404);
  if (user.role === "guest" || user.role === "admin") throw new AppError("You can already host contests.", 400);
  if (await HostRequestModel.exists({ userId, status: "pending" })) throw new AppError(PENDING_CONFLICT_MESSAGE, 409);

  try {
    const created = await HostRequestModel.create({
      userId,
      organization,
      contestTitle,
      contestDescription,
      proposedStartTime,
      proposedEndTime,
      expectedParticipants,
      contactEmail: contactEmail ?? user.email,
      message,
    });
    await notificationService.notifyAdmins({
      type: "host.requested",
      title: "New host request",
      body: `"${contestTitle}" is waiting for review.`,
      href: "/admin/host-requests",
    });
    return toHostRequestDto(created.toObject() as unknown as LeanHostRequest);
  } catch (error) {
    // Two submissions that both got past the exists() check above — the
    // partial unique index (see HostRequest.model.ts) rejects the second.
    if (isDuplicateKeyError(error)) throw new AppError(PENDING_CONFLICT_MESSAGE, 409);
    throw error;
  }
};

// The caller's current role plus their most recent request of any status, so
// the client can show "apply", "pending", "rejected" or "you can host".
const getMyRequest = async (userId: string, role: IUser["role"]) => {
  const request = (await HostRequestModel.findOne({ userId }).sort({ createdAt: -1, _id: -1 }).lean()) as unknown as LeanHostRequest | null;
  return { role, request: request ? toHostRequestDto(request) : null };
};

interface IListRequestsQuery {
  status?: unknown;
  page?: unknown;
  limit?: unknown;
}

const listRequests = async ({ status: rawStatus, page, limit }: IListRequestsQuery) => {
  const status = rawStatus === undefined || rawStatus === "" ? "pending" : rawStatus;
  if (status !== "all" && !REQUEST_STATUSES.includes(status as HostRequestStatus)) {
    throw new AppError("status must be one of: pending, approved, rejected, all.", 400);
  }
  const filter: FilterQuery<IHostRequest> = status === "all" ? {} : { status: status as HostRequestStatus };

  const safeLimit = Math.min(toPositiveInt(limit, 20), 100);
  const safePage = toPositiveInt(page, 1);

  const [requests, total, pendingCount] = (await Promise.all([
    HostRequestModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    HostRequestModel.countDocuments(filter),
    HostRequestModel.countDocuments({ status: "pending" }),
  ])) as unknown as [LeanHostRequest[], number, number];

  const userIds = [...new Set(requests.map((request) => String(request.userId)))];
  const users =
    userIds.length > 0
      ? ((await UserModel.find({ _id: { $in: userIds } })
          .select("name email role")
          .lean()) as unknown as LeanRequestUser[])
      : [];
  const userById = new Map(users.map((user) => [String(user._id), user]));

  return {
    // A request whose user has since been deleted is listed without `user`.
    items: requests.map((request) => toHostRequestDto(request, userById.get(String(request.userId)))),
    total,
    page: safePage,
    limit: safeLimit,
    pendingCount,
  };
};

const reviewRequest = async (requestId: string, reviewerId: string, payload: unknown) => {
  if (!Types.ObjectId.isValid(requestId)) throw new AppError("Host request not found.", 404);
  const body = toBodyObject(payload);
  const { action } = body;
  if (action !== "approve" && action !== "reject") throw new AppError('action must be "approve" or "reject".', 400);
  const note = optionalText(body.note, "note", 500);

  const request = (await HostRequestModel.findById(requestId).lean()) as unknown as LeanHostRequest | null;
  if (!request) throw new AppError("Host request not found.", 404);
  if (request.status !== "pending") throw new AppError("This request has already been reviewed.", 409);
  if (action === "approve" && !(await UserModel.exists({ _id: request.userId }))) {
    throw new AppError("The user who sent this request no longer exists.", 404);
  }

  // Conditioned on the request still being pending, so two admins reviewing
  // it at the same moment can't both win — the second gets the same 409 as
  // reviewing from a stale list.
  const reviewed = (await HostRequestModel.findOneAndUpdate(
    { _id: request._id, status: "pending" },
    {
      $set: {
        status: action === "approve" ? "approved" : "rejected",
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        ...(note ? { reviewNote: note } : {}),
      },
    },
    { new: true },
  ).lean()) as unknown as LeanHostRequest | null;
  if (!reviewed) throw new AppError("This request has already been reviewed.", 409);

  if (action === "approve") {
    try {
      // Only a plain user is promoted: someone who became an admin (or is
      // already a guest) in the meantime keeps their role, so approving a
      // request can never downgrade anyone.
      await UserModel.updateOne({ _id: request.userId, role: "user" }, { $set: { role: "guest" } });
    } catch (error) {
      // Put the request back so it can be approved again, instead of it
      // staying "approved" for a user who never actually got the role.
      await HostRequestModel.updateOne(
        { _id: request._id },
        { $set: { status: "pending" }, $unset: { reviewNote: 1, reviewedBy: 1, reviewedAt: 1 } },
      ).catch(() => undefined);
      throw error;
    }
  }

  await notificationService.notifyUser(
    request.userId,
    action === "approve"
      ? {
          type: "host.approved",
          title: "You can host contests now",
          body: `Your request to run "${request.contestTitle}" was approved.${note ? ` ${note}` : ""}`,
          href: "/admin/contests",
        }
      : {
          type: "host.rejected",
          title: "Your host request was declined",
          body: `"${request.contestTitle}"${note ? ` — ${note}` : ""}`,
          href: "/host",
        },
  );

  const user = (await UserModel.findById(request.userId).select("name email role").lean()) as unknown as LeanRequestUser | null;
  return toHostRequestDto(reviewed, user);
};

export const hostService = { createRequest, getMyRequest, listRequests, reviewRequest };

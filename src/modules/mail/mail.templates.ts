// The HTML and plain-text bodies of every message Kaimana sends.
//
// Email clients are not browsers: no external stylesheet, no CSS variables,
// no flexbox worth trusting, and Gmail strips inline SVG outright. So a
// message here is one centred table with inline styles, the mark is the PNG
// the site already serves, and every message carries a text/plain twin —
// some clients show it, spam filters read it, and a message without one
// scores worse.

import { config } from "../../config/env.js";

export interface BuiltMail {
  subject: string;
  html: string;
  text: string;
}

const site = () => config.frontendUrls[0] ?? "https://kaimana.vercel.app";

const api = () => (config.publicApiUrl ?? "").replace(/\/$/, "");

/** The footer every optional email carries. */
const optOut = (token: string | undefined, kind: "contestReminders" | "weeklyDigest", what: string) =>
  token && api()
    ? `You get this because ${what}. <a href="${api()}/api/mail/unsubscribe?token=${encodeURIComponent(token)}&type=${kind}" style="color:${ACCENT};text-decoration:none;">Turn these off</a>, or choose what reaches you in <a href="${site()}/profile" style="color:${ACCENT};text-decoration:none;">your profile</a>.`
    : `You get this because ${what}. Choose what reaches you in <a href="${site()}/profile" style="color:${ACCENT};text-decoration:none;">your profile</a>.`;

// Names and titles come from user input and land inside markup.
const escape = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const BG = "#0A0B0D";
const SURFACE = "#121417";
const BORDER = "#242830";
const TEXT = "#E8EAED";
const DIM = "#9AA1AC";
const ACCENT = "#4FF0C5";

const layout = ({
  heading,
  lines,
  button,
  footnote,
}: {
  heading: string;
  lines: string[];
  button?: { label: string; href: string };
  footnote?: string;
}) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(heading)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${SURFACE};border:1px solid ${BORDER};border-radius:16px;">
        <tr><td style="padding:28px 28px 0;">
          <img src="${site()}/icons/icon-192.png" width="40" height="40" alt="" style="display:block;border:0;border-radius:10px;">
          <p style="margin:14px 0 0;font:700 21px/1.2 Segoe UI,Helvetica,Arial,sans-serif;color:${TEXT};">K<span style="color:${ACCENT};">aimana</span></p>
        </td></tr>
        <tr><td style="padding:22px 28px 0;">
          <h1 style="margin:0;font:700 22px/1.3 Segoe UI,Helvetica,Arial,sans-serif;color:${TEXT};">${escape(heading)}</h1>
          ${lines.map((line) => `<p style="margin:14px 0 0;font:15px/1.65 Segoe UI,Helvetica,Arial,sans-serif;color:${DIM};">${line}</p>`).join("")}
        </td></tr>
        ${
          button
            ? `<tr><td style="padding:24px 28px 0;">
          <a href="${escape(button.href)}" style="display:inline-block;padding:13px 22px;border-radius:9px;background:${ACCENT};color:${BG};font:700 14px Segoe UI,Helvetica,Arial,sans-serif;text-decoration:none;">${escape(button.label)}</a>
          <p style="margin:14px 0 0;font:12px/1.6 Segoe UI,Helvetica,Arial,sans-serif;color:${DIM};word-break:break-all;">Or paste this into your browser:<br><span style="color:${ACCENT};">${escape(button.href)}</span></p>
        </td></tr>`
            : ""
        }
        <tr><td style="padding:26px 28px 28px;">
          <div style="height:1px;background:${BORDER};"></div>
          <p style="margin:16px 0 0;font:12px/1.6 Segoe UI,Helvetica,Arial,sans-serif;color:${DIM};">${
            footnote ??
            `You are receiving this because this address is used on <a href="${site()}" style="color:${ACCENT};text-decoration:none;">Kaimana</a>.`
          }</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

/** The link that lets someone set a new password. */
const passwordReset = ({ name, url, minutes }: { name: string; url: string; minutes: number }): BuiltMail => ({
  subject: "Reset your Kaimana password",
  html: layout({
    heading: "Set a new password",
    lines: [
      `Hi ${escape(name)}, someone asked to reset the password for this account.`,
      `The link works once and expires in ${minutes} minutes.`,
      "If this was not you, ignore this message — nothing changes until the link is used, and your current password still works.",
    ],
    button: { label: "Choose a new password", href: url },
    footnote: "Kaimana will never ask you for your password by email.",
  }),
  text: [
    `Hi ${name},`,
    "",
    "Someone asked to reset the password for your Kaimana account.",
    `Open this link to choose a new one. It works once and expires in ${minutes} minutes:`,
    url,
    "",
    "If this was not you, ignore this message. Nothing changes until the link is used.",
  ].join("\n"),
});

/** Sent after a reset succeeds — how someone learns their account was taken. */
const passwordChanged = ({ name }: { name: string }): BuiltMail => ({
  subject: "Your Kaimana password was changed",
  html: layout({
    heading: "Your password was changed",
    lines: [
      `Hi ${escape(name)}, the password for your Kaimana account has just been changed, and every other signed-in device was signed out.`,
      "If that was you, there is nothing to do.",
      "If it was not, reset the password now — that locks whoever has it out again.",
    ],
    button: { label: "Reset it again", href: `${site()}/forgot-password` },
  }),
  text: [
    `Hi ${name},`,
    "",
    "The password for your Kaimana account was just changed, and every other signed-in device was signed out.",
    "If that was not you, reset it now:",
    `${site()}/forgot-password`,
  ].join("\n"),
});

/** A reset asked for on an account that only signs in with Google. */
const passwordResetGoogleAccount = ({ name }: { name: string }): BuiltMail => ({
  subject: "Sign in to Kaimana with Google",
  html: layout({
    heading: "This account uses Google",
    lines: [
      `Hi ${escape(name)}, someone asked to reset a password for this address — but this account signs in with Google, so there is no password to reset.`,
      "Use the Google button on the sign-in page and you are straight in.",
    ],
    button: { label: "Go to sign in", href: `${site()}/signin` },
  }),
  text: [
    `Hi ${name},`,
    "",
    "Someone asked to reset a password for this address, but this account signs in with Google and has no password.",
    `Use the Google button here: ${site()}/signin`,
  ].join("\n"),
});

const welcome = ({ name }: { name: string }): BuiltMail => ({
  subject: "Welcome to Kaimana",
  html: layout({
    heading: `Welcome, ${escape(name)}`,
    lines: [
      "Your account is ready. Pick a problem, write a solution, and a real judge runs it against the tests — then the AI coach explains what your code actually costs.",
      "Solved problems earn gems, gems pay for hints, and contests put all of it on a clock.",
    ],
    button: { label: "Start solving", href: `${site()}/problems` },
  }),
  text: [
    `Welcome, ${name}.`,
    "",
    "Your Kaimana account is ready. Pick a problem and a real judge will run your solution against the tests:",
    `${site()}/problems`,
  ].join("\n"),
});

/** An in-site notification that is worth an email as well. */
const notification = ({ name, title, body, href }: { name: string; title: string; body?: string; href?: string }): BuiltMail => {
  const link = href ? (href.startsWith("http") ? href : `${site()}${href}`) : undefined;
  return {
    subject: title,
    html: layout({
      heading: title,
      lines: [`Hi ${escape(name)},`, ...(body ? [escape(body)] : [])],
      button: link ? { label: "Open Kaimana", href: link } : undefined,
      footnote: `Sent because this happened on your Kaimana account. Choose what reaches you in <a href="${site()}/profile" style="color:${ACCENT};text-decoration:none;">your profile</a>.`,
    }),
    text: [`Hi ${name},`, "", title, ...(body ? ["", body] : []), ...(link ? ["", link] : [])].join("\n"),
  };
};

/** Proof that the address on an account can actually receive mail. */
const verifyEmail = ({ name, url, minutes }: { name: string; url: string; minutes: number }): BuiltMail => ({
  subject: "Confirm your email for Kaimana",
  html: layout({
    heading: "Confirm this address",
    lines: [
      `Hi ${escape(name)}, one click and this address is confirmed on your Kaimana account.`,
      `The link works once and expires in ${minutes} minutes.`,
      "Confirming means a password reset can actually reach you, and that contest mail goes where you expect.",
    ],
    button: { label: "Confirm my email", href: url },
    footnote: "If you did not create a Kaimana account, ignore this — nothing happens until the link is used.",
  }),
  text: [`Hi ${name},`, "", "Confirm your email address for Kaimana:", url, "", `The link works once and expires in ${minutes} minutes.`].join("\n"),
});

/** A contest someone registered for is about to start. */
const contestReminder = ({
  name,
  contest,
  startsIn,
  unsubscribeToken,
}: {
  name: string;
  contest: { title: string; slug: string; startTime: Date };
  startsIn: string;
  unsubscribeToken?: string;
}): BuiltMail => {
  const url = `${site()}/contests/${contest.slug}`;
  const when = contest.startTime.toUTCString();
  return {
    subject: `${contest.title} starts ${startsIn}`,
    html: layout({
      heading: `${escape(contest.title)} starts ${escape(startsIn)}`,
      lines: [
        `Hi ${escape(name)}, you are registered for this one.`,
        `It opens at ${escape(when)} and the clock starts the moment you do.`,
        "Open the problems a minute early, pick your language, and have the editor ready.",
      ],
      button: { label: "Go to the contest", href: url },
      footnote: optOut(unsubscribeToken, "contestReminders", "you registered for this contest"),
    }),
    text: [`Hi ${name},`, "", `${contest.title} starts ${startsIn} (${when}).`, url].join("\n"),
  };
};

/** How it went, once the contest is over and the standings are final. */
const contestResults = ({
  name,
  contest,
  rank,
  total,
  score,
  solved,
  unsubscribeToken,
}: {
  name: string;
  contest: { title: string; slug: string };
  rank: number | null;
  total: number;
  score: number;
  solved: number;
  unsubscribeToken?: string;
}): BuiltMail => {
  const url = `${site()}/contests/${contest.slug}`;
  const placed = rank ? `You finished ${rank} of ${total}` : "You did not submit anything this time";
  return {
    subject: `${contest.title}: the final standings`,
    html: layout({
      heading: `${escape(contest.title)} is over`,
      lines: [
        `Hi ${escape(name)}, the standings are final.`,
        `${escape(placed)}, with ${score} points from ${solved} ${solved === 1 ? "problem" : "problems"}.`,
        "The problems stay open for practice, and the community feed now has everyone's accepted code for them.",
      ],
      button: { label: "See the scoreboard", href: url },
      footnote: optOut(unsubscribeToken, "contestReminders", "you took part in this contest"),
    }),
    text: [`Hi ${name},`, "", `${contest.title} is over. ${placed}, with ${score} points from ${solved}.`, url].join("\n"),
  };
};

/** The week, in four numbers and a short list. */
const weeklyDigest = ({
  name,
  solvedThisWeek,
  streakDays,
  gems,
  newProblems,
  upcomingContests,
  unsubscribeToken,
}: {
  name: string;
  solvedThisWeek: number;
  streakDays: number;
  gems: number;
  newProblems: { title: string; slug: string; difficulty: string }[];
  upcomingContests: { title: string; slug: string; startTime: Date }[];
  unsubscribeToken?: string;
}): BuiltMail => {
  const problemList = newProblems
    .map((problem) => `<a href="${site()}/problems/${problem.slug}" style="color:${ACCENT};text-decoration:none;">${escape(problem.title)}</a> · ${escape(problem.difficulty.toLowerCase())}`)
    .join("<br>");
  const contestList = upcomingContests
    .map((contest) => `<a href="${site()}/contests/${contest.slug}" style="color:${ACCENT};text-decoration:none;">${escape(contest.title)}</a> · ${escape(contest.startTime.toUTCString())}`)
    .join("<br>");

  return {
    subject: solvedThisWeek ? `You solved ${solvedThisWeek} this week` : "Your week on Kaimana",
    html: layout({
      heading: solvedThisWeek ? `${solvedThisWeek} solved this week` : "Nothing solved this week",
      lines: [
        `Hi ${escape(name)}.`,
        streakDays > 0
          ? `Your streak is at ${streakDays} ${streakDays === 1 ? "day" : "days"}, and you have ${gems} gems.`
          : `You have ${gems} gems waiting to be spent on hints.`,
        ...(problemList ? [`<b style="color:#E8EAED;">New problems</b><br>${problemList}`] : []),
        ...(contestList ? [`<b style="color:#E8EAED;">Coming up</b><br>${contestList}`] : []),
      ],
      button: { label: "Pick your next problem", href: `${site()}/problems` },
      footnote: optOut(unsubscribeToken, "weeklyDigest", "you asked for a weekly summary"),
    }),
    text: [
      `Hi ${name},`,
      "",
      `Solved this week: ${solvedThisWeek}. Streak: ${streakDays} days. Gems: ${gems}.`,
      ...(newProblems.length ? ["", "New problems:", ...newProblems.map((problem) => `- ${problem.title} (${problem.difficulty.toLowerCase()}) ${site()}/problems/${problem.slug}`)] : []),
      ...(upcomingContests.length ? ["", "Coming up:", ...upcomingContests.map((contest) => `- ${contest.title} ${contest.startTime.toUTCString()}`)] : []),
    ].join("\n"),
  };
};

export const mailTemplates = {
  verifyEmail,
  passwordReset,
  passwordChanged,
  passwordResetGoogleAccount,
  welcome,
  notification,
  contestReminder,
  contestResults,
  weeklyDigest,
};

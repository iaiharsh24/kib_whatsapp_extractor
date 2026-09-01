import type { ActivityLogRecord } from "./types";

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "logged in",
  "auth.signup": "signed up",
  "workspace.create": "created workspace",
  "workspace.rename": "renamed workspace",
  "workspace.delete": "deleted workspace",
  "workspace.member.remove": "removed workspace member",
  "workspace.invite.create": "created workspace invite",
  "workspace.invite.revoke": "revoked workspace invite",
  "workspace.invite.accept": "joined workspace",
  "tag.create": "created tag",
  "tag.rename": "renamed tag",
  "tag.delete": "deleted tag",
  "upload.start": "started upload",
  "upload.completed": "finished processing upload",
  "upload.failed": "upload failed",
  "upload.delete": "deleted upload",
  "project.create": "created project",
  "project.rename": "renamed project",
  "project.delete": "deleted project",
  "project.duplicate": "duplicated project",
  "canvas.create": "created canvas",
  "admin.user.create": "created user account",
  "admin.user.reset_password": "reset user password",
  "admin.user.role_change": "changed user role",
  "admin.user.delete": "removed user",
  "admin.signup_code.create": "created signup code",
  "admin.signup_code.revoke": "revoked signup code",
};

export function describeActivity(log: ActivityLogRecord): { who: string; what: string } {
  const who = `@${log.username}`;
  const verb = ACTION_LABELS[log.action] || log.action.replace(/\./g, " ");
  let what = verb.toUpperCase();
  if (log.resource_name) what += ` "${log.resource_name}"`;
  const workspaceName = log.details?.workspace_name;
  if (typeof workspaceName === "string" && workspaceName) {
    what += ` in ${workspaceName}`;
  }
  const projectName = log.details?.project_name;
  if (typeof projectName === "string" && projectName && log.action !== "project.create") {
    what += ` (project: ${projectName})`;
  }
  if (log.action === "upload.completed" && typeof log.details?.message_count === "number") {
    what += ` · ${log.details.message_count} messages`;
  }
  return { who, what };
}

export function roleBadge(role: string | null | undefined, viewerSuper = false): string {
  if (!role) return "MEMBER";
  if (role === "superadmin" && !viewerSuper) return "ADMIN";
  return role.toUpperCase();
}

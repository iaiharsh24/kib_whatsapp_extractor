export type Role = "superadmin" | "admin" | "member";
export type WorkspaceRole = "owner" | "member";

export type UserRecord = {
  id: string;
  username: string;
  email?: string | null;
  role: Role;
  is_super_admin?: boolean;
  created_at?: string | null;
  temporary_password?: string;
};

export type AuthResponse = {
  token: string;
  user: UserRecord;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  owner_id: string;
  created_at: string | null;
  role: WorkspaceRole | null;
  project_count?: number;
  upload_count?: number;
  message_count?: number;
};

export type WorkspaceMemberRecord = {
  user_id: string;
  username: string;
  email?: string | null;
  role: WorkspaceRole;
  joined_at: string | null;
};

export type InviteRecord = {
  id: string;
  workspace_id: string;
  code: string;
  role: WorkspaceRole;
  created_by: string;
  created_at: string | null;
  used_count: number;
  revoked: boolean;
  link: string;
};

export type SignupPreview = {
  code: string;
  note?: string | null;
  workspace_name?: string | null;
  uses_remaining: number;
};

export type SignupCodeRecord = {
  id: string;
  code: string;
  note?: string | null;
  max_uses: number;
  used_count: number;
  revoked: boolean;
  workspace_id?: string | null;
  workspace_role: WorkspaceRole;
  created_by: string;
  created_at: string | null;
  link: string;
};

export type InvitePreview = {
  workspace_name: string;
  invited_by: string;
  role: WorkspaceRole;
};

export type TagRecord = {
  id: string;
  name: string;
  count: number;
  created_at: string | null;
};

export type LinkPreview = {
  url: string;
  domain?: string;
  title?: string;
  description?: string;
  image?: string | null;
  site?: string;
  embed?: string | null;
  urls?: string[];
  kind?: string;
  fetched?: boolean;
};

export type MessageRecord = {
  id: string;
  upload_id: string;
  sender: string;
  timestamp: string | null;
  raw_text: string;
  type: "chat" | "link" | "document" | "reel" | "media_omitted" | string;
  extracted_url: string | null;
  extracted_filename: string | null;
  context_before: string | null;
  context_after: string | null;
  chat_name: string | null;
  tags: string[];
  link_preview?: LinkPreview | null;
  urls?: string[];
};

export type LibraryResponse = {
  total: number;
  offset: number;
  items: MessageRecord[];
  counts?: {
    chat: number;
    link: number;
    document: number;
    image: number;
    reel: number;
  };
};

export type UploadLibrarySummary = {
  upload: UploadRecord;
  counts: {
    chat: number;
    link: number;
    document: number;
    image: number;
    reel: number;
    total: number;
  };
};

export type LibraryFilterOptions = {
  senders: string[];
  tags: string[];
  chats: string[];
  sites: string[];
};

export type LibraryFilterState = {
  q: string;
  sender: string;
  chat: string;
  tag: string;
  site: string;
  dateFrom: string;
  dateTo: string;
};

export type CanvasSummary = {
  id: string;
  name: string;
  project_id: string;
  created_at: string | null;
};

export type UploadRecord = {
  id: string;
  workspace_id?: string | null;
  project_id?: string | null;
  file_name: string;
  uploaded_by: string;
  uploaded_by_username?: string | null;
  uploaded_at: string | null;
  status: string;
  message_count: number;
  duplicate_count?: number;
  error_message: string | null;
  chat_name: string | null;
};

export type ProjectRecord = {
  id: string;
  workspace_id?: string | null;
  name: string;
  created_by: string;
  created_at: string | null;
};

export type CanvasState = {
  nodes: unknown[];
  edges: unknown[];
  frames: unknown[];
  viewport?: { x: number; y: number; zoom: number } | null;
};

export type CanvasHistoryEntry = {
  id: string;
  at: string | null;
};

export type ChatEntry = {
  role: "user" | "assistant";
  text: string;
  at?: string | null;
};

export type ProjectDetail = {
  project: ProjectRecord;
  canvas: CanvasState & { id?: string | null; name?: string };
  canvas_id: string;
  canvases: CanvasSummary[];
  uploads: UploadRecord[];
  items: MessageRecord[];
};

export type ActivityLogRecord = {
  id: string;
  user_id: string | null;
  username: string;
  user_role: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  resource_name: string | null;
  workspace_id: string | null;
  details: Record<string, unknown>;
  created_at: string | null;
};

export type ActivityLogResponse = {
  total: number;
  items: ActivityLogRecord[];
};

export type DbSnapshotRecord = {
  id: string;
  created_at: string | null;
  kind: string;
  backend: string;
  file_name: string;
  size_bytes: number;
  stats: Record<string, unknown>;
  notes: string | null;
};

export type DbSnapshotResponse = {
  total: number;
  items: DbSnapshotRecord[];
};

export type DbUploadSummary = {
  id: string;
  file_name: string;
  status: string;
  message_count: number;
  duplicate_count: number;
  uploaded_by_username?: string | null;
  uploaded_at: string | null;
  chat_name: string | null;
  error_message: string | null;
};

export type DbProjectSummary = {
  id: string;
  name: string;
  created_at: string | null;
  uploads: DbUploadSummary[];
  message_count: number;
  canvas_count: number;
};

export type DbWorkspaceSummary = {
  id: string;
  name: string;
  owner_id: string;
  owner_username?: string | null;
  created_at: string | null;
  project_count: number;
  upload_count: number;
  message_count: number;
  projects: DbProjectSummary[];
};

export type DbOverview = {
  backend: string;
  totals: {
    workspaces: number;
    projects: number;
    uploads: number;
    messages: number;
    users: number;
    members: number;
  };
  workspaces: DbWorkspaceSummary[];
};

export type ControlCanvasSummary = {
  id: string;
  name: string;
  project_id: string;
  created_at: string | null;
  node_count: number;
  edge_count: number;
  frame_count: number;
};

export type ControlProjectSummary = {
  id: string;
  name: string;
  workspace_id: string | null;
  workspace_name: string | null;
  created_by: string;
  created_by_username?: string | null;
  created_at: string | null;
  message_count: number;
  upload_count: number;
  canvas_count: number;
  canvases: ControlCanvasSummary[];
  uploads: UploadRecord[];
};

export type ControlWorkspaceSummary = {
  id: string;
  name: string;
  role: string;
  project_count: number;
  created_at: string | null;
};

export type ControlUserRow = {
  user: UserRecord;
  email: string | null;
  owned_workspaces: ControlWorkspaceSummary[];
  member_workspaces: ControlWorkspaceSummary[];
  projects_created: ControlProjectSummary[];
  uploads: UploadRecord[];
  totals: {
    projects_created: number;
    canvases: number;
    uploads: number;
    messages_in_projects: number;
  };
};

export type ControlOverview = {
  generated_at: string;
  totals: {
    users: number;
    workspaces: number;
    projects: number;
    canvases: number;
    uploads: number;
    messages: number;
  };
  users: ControlUserRow[];
};

export type Role = "admin" | "member";
export type WorkspaceRole = "owner" | "member";

export type UserRecord = {
  id: string;
  username: string;
  email?: string | null;
  role: Role;
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

export type UploadRecord = {
  id: string;
  workspace_id?: string | null;
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
  canvas: CanvasState;
  items: MessageRecord[];
};

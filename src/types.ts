export interface Env {
  OPENAI_API_KEY: string;
  DOCS_ARTIFACTS?: R2Bucket;
  DOCS_INDEX_URL?: string;
  DOCS_CORPUS_URL?: string;
  SOURCE_INDEX_URL?: string;
  GITHUB_INDEX_URL?: string;
  WORKSPACE_MANIFEST_URL?: string;
  OPENAI_MODEL?: string;
  ASK_MOLTY_AUTH_SECRET?: string;
  OPENCLAW_ID_ISSUER?: string;
  OPENCLAW_ID_CLIENT_ID?: string;
  OPENCLAW_ID_CLIENT_SECRET?: string;
}

export interface SearchRecord {
  kind: "docs" | "source" | "github";
  path: string;
  title?: string;
  url?: string;
  rawUrl?: string;
  commit?: string;
  state?: string;
  number?: number;
  labels?: string[];
  files?: string[];
  workspacePath?: string;
  search: string;
}

export interface WorkspaceFile {
  path: string;
  kind: SearchRecord["kind"];
  url?: string;
  content: string;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface OpenAIChatResponse {
  choices?: Array<{
    message?: OpenAIMessage;
  }>;
}

export interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

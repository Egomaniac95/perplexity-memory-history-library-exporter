export interface ThreadLink {
  id: string;
  title: string;
  url: string;
  slug: string;
}

export interface ThreadData {
  steps?: Array<{
    step_type: string;
    query_str?: string;
    final_response?: string;
  }>;
  [key: string]: unknown;
}

export interface ExportResult {
  success: boolean;
  log: string[];
  data?: ThreadData[];
  count?: number;
  successCount?: number;
  errorCount?: number;
  error?: string;

  /** Thread IDs that finished with status ok or no_steps. */
  completedThreadIds?: string[];

  /** Thread IDs that returned a thread object but had no steps. */
  noStepThreadIds?: string[];

  /** Thread IDs that failed after retries or threw an exception. */
  failedThreadIds?: string[];
}

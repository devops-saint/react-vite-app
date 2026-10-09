/**
 * Q&A forum (idea #15). Questions and their comment threads are stored by
 * the main Lambda (GET/POST /qna, GET /qna/{id}, POST /qna/{id}/comments).
 * Authors are exposed by display name only - emails never leave the
 * backend.
 */
export type QnaStatus = 'OPEN' | 'ANSWERED';

export interface QnaQuestionSummary {
  questionId: string;
  title: string;
  body: string;
  askedByName: string;
  askedById?: string;
  /** ANSWERED once an admin has responded; ordinary comments don't change it. */
  status: QnaStatus;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  /** Start of the first admin answer, for list views and troubleshooting search. */
  answerPreview: string | null;
}

export interface QnaComment {
  commentId: string;
  body: string;
  authorName: string;
  /** True when the backend verified the author as an admin. */
  isAdmin: boolean;
  createdAt: string;
}

export interface QnaQuestionDetail extends QnaQuestionSummary {
  comments: QnaComment[];
}

export interface QnaAuthor {
  id: string;
  name: string;
  email: string;
}

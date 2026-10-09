import apiGatewayAxios from '../apiGatewayAxios';
import type {
  QnaAuthor,
  QnaQuestionDetail,
  QnaQuestionSummary,
} from '@/types/qna.types';

/**
 * Client for the Q&A forum routes on the main Lambda. Asking a question
 * emails the configured admins (server-side); an admin's comment marks the
 * question answered and emails the asker.
 */

// Some Lambda proxy responses come back without an explicit
// application/json Content-Type, in which case axios leaves the body as a
// raw string instead of parsing it - handle both (same as accessService).
function unwrap<T>(data: unknown): T {
  const value: unknown = typeof data === 'string' ? JSON.parse(data) : data;
  return value as T;
}

export const qnaService = {
  async list(): Promise<QnaQuestionSummary[]> {
    const response = await apiGatewayAxios.get<unknown>('/qna');
    const data = unwrap<{ questions?: QnaQuestionSummary[] }>(response.data);
    return data.questions ?? [];
  },

  async get(questionId: string): Promise<QnaQuestionDetail> {
    const response = await apiGatewayAxios.get<unknown>(
      `/qna/${encodeURIComponent(questionId)}`
    );
    return unwrap<QnaQuestionDetail>(response.data);
  },

  async ask(
    input: { title: string; body: string },
    askedBy: QnaAuthor
  ): Promise<QnaQuestionDetail> {
    const response = await apiGatewayAxios.post<unknown>('/qna', {
      title: input.title,
      body: input.body,
      askedBy,
    });
    return unwrap<QnaQuestionDetail>(response.data);
  },

  /** Returns the updated thread (including the new comment). */
  async addComment(
    questionId: string,
    body: string,
    author: QnaAuthor
  ): Promise<QnaQuestionDetail> {
    const response = await apiGatewayAxios.post<unknown>(
      `/qna/${encodeURIComponent(questionId)}/comments`,
      { body, author }
    );
    return unwrap<QnaQuestionDetail>(response.data);
  },
};

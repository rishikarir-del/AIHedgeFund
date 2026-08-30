/**
 * Server-side API client factory.
 *
 * CLAUDE.md 18.5 puts stable read views in server components, so the token
 * never reaches the browser. This module is server-only by construction: it
 * reads process.env, which is unavailable in a client component.
 */
import 'server-only';
import { ApiClient } from './api-client';

export function serverApiClient(): ApiClient {
  const baseUrl = process.env['ARF_API_URL'] ?? 'http://127.0.0.1:3001';
  const token = process.env['ARF_API_TOKEN'];

  if (!token) {
    throw new Error(
      'ARF_API_TOKEN is not set. In development use a dev token of the form "dev:<subject>".',
    );
  }

  return new ApiClient({ baseUrl, token });
}

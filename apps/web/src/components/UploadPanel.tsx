'use client';

/**
 * Presigned upload panel.
 *
 * CLAUDE.md 15.1: uploads go direct to object storage via a presigned URL,
 * never through the API. The checksum is computed in the browser before the
 * request, because the key is derived from it server-side and the completion
 * call verifies the stored bytes hash to the same value.
 */
import { useState, type ChangeEvent, type ReactElement } from 'react';

type Status = 'idle' | 'hashing' | 'requesting' | 'uploading' | 'completing' | 'done' | 'error';

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function UploadPanel({
  verificationId,
  reportType,
  apiBaseUrl,
}: {
  readonly verificationId: string;
  readonly reportType: 'performance_summary' | 'list_of_trades';
  readonly apiBaseUrl: string;
}): ReactElement {
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string>('');
  const [checksum, setChecksum] = useState<string>('');

  async function onSelect(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setStatus('hashing');
      setMessage(`Hashing ${file.name}…`);
      const digest = await sha256Hex(file);
      setChecksum(digest);

      setStatus('requesting');
      setMessage('Requesting an upload ticket…');
      const ticketResponse = await fetch(
        `${apiBaseUrl}/v1/tradingview-verifications/${verificationId}/upload-ticket`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            reportType,
            checksum: digest,
            contentType: file.type || 'text/csv',
            sizeBytes: file.size,
          }),
        },
      );
      if (!ticketResponse.ok) {
        const problem = await ticketResponse.json().catch(() => null);
        throw new Error(problem?.detail ?? `Ticket request failed (${ticketResponse.status}).`);
      }
      const ticket = (await ticketResponse.json()) as { url: string; objectKey: string };

      setStatus('uploading');
      setMessage('Uploading to object storage…');
      const put = await fetch(ticket.url, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type || 'text/csv' },
      });
      if (!put.ok) throw new Error(`Storage rejected the upload (${put.status}).`);

      setStatus('completing');
      setMessage('Verifying the stored file…');
      const complete = await fetch(
        `${apiBaseUrl}/v1/tradingview-verifications/${verificationId}/uploads`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            reportType,
            checksum: digest,
            contentType: file.type || 'text/csv',
            sizeBytes: file.size,
          }),
        },
      );
      if (!complete.ok) {
        const problem = await complete.json().catch(() => null);
        throw new Error(problem?.detail ?? `Completion failed (${complete.status}).`);
      }

      setStatus('done');
      setMessage('Upload verified and recorded.');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    }
  }

  const busy = ['hashing', 'requesting', 'uploading', 'completing'].includes(status);

  return (
    <div className="state-machine">
      <label htmlFor={`upload-${reportType}`}>
        <strong>{reportType === 'list_of_trades' ? 'List of Trades' : 'Performance Summary'}</strong>
      </label>
      <input
        id={`upload-${reportType}`}
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => void onSelect(event)}
        disabled={busy}
      />
      {status !== 'idle' ? (
        <p role="status" aria-live="polite" className={status === 'error' ? 'divergence-note' : ''}>
          {message}
        </p>
      ) : null}
      {checksum ? <p className="trace">sha256 {checksum.slice(0, 24)}…</p> : null}
    </div>
  );
}

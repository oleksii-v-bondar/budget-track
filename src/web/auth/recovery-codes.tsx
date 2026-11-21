import { useState } from 'react';
import { Button } from '../ui/button';

/** The recovery codes, shown once (spec §12), with Copy and Download so the owner can keep them somewhere safe. */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = `Budget Track recovery codes (each works once)\n\n${codes.join('\n')}\n`;
  const onCopy = () =>
    navigator.clipboard.writeText(text).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-4 font-mono text-sm">
        {codes.map((code) => (
          <li key={code} className="text-center whitespace-nowrap">
            {code}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={onCopy}>
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </Button>
        <a
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
          download="budget-track-recovery-codes.txt"
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-white font-semibold ring-1 ring-gray-300 hover:bg-gray-50"
        >
          Download
        </a>
      </div>
      {copy === 'failed' && <p className="text-sm text-red-600">Couldn't copy. Select the codes and copy them instead.</p>}
    </div>
  );
}

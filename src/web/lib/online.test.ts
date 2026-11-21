import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useOnline } from './online';

describe('useOnline', () => {
  it('follows the browser going offline and back online', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
    act(() => {
      onLine.mockReturnValue(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);
    act(() => {
      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });
});

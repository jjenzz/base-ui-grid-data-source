import * as React from 'react';

/**
 * Same identity every render but calls the latest `callback`, so it can go in a memoised context value. Updated in an
 * insertion effect, before any layout effect can call it.
 */
export function useStableCallback<A extends unknown[], R>(callback: (...args: A) => R) {
  const ref = React.useRef(callback);
  React.useInsertionEffect(() => {
    ref.current = callback;
  });
  return React.useCallback((...args: A) => ref.current(...args), []);
}

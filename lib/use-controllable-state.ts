'use client';

import * as React from 'react';

// State without a reason is set with just the value. State with one has to say why it changed.
type ReasonArgs<Reason> = [Reason] extends [undefined] ? [reason?: Reason] : [reason: Reason];

type Params<T, Reason> = {
  prop?: T;
  defaultProp: T;
  onChange?: (value: T, ...reason: ReasonArgs<Reason>) => void;
};

export function useControllableState<T, Reason = undefined>(params: Params<T, Reason>) {
  const isControlled = params.prop !== undefined;
  const [internalValue, setValue] = React.useState<T | undefined>(isControlled ? undefined : params.defaultProp);
  const value = (isControlled ? params.prop : internalValue) as T;

  const latest = React.useRef({ value, isControlled, onChange: params.onChange });
  React.useLayoutEffect(() => {
    latest.current = { value, isControlled, onChange: params.onChange };
  }, [value, isControlled, params.onChange]);

  const handleChange = React.useCallback((change: React.SetStateAction<T>, ...reason: ReasonArgs<Reason>) => {
    const { value, isControlled, onChange } = latest.current;
    const nextValue = typeof change === 'function' ? (change as (previous: T) => T)(value) : change;
    if (value !== nextValue) onChange?.(nextValue, ...reason);
    if (!isControlled) {
      latest.current.value = nextValue;
      setValue(nextValue);
    }
  }, []);

  return [value, handleChange] as const;
}

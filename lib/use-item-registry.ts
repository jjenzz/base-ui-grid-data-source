'use client';

import * as React from 'react';
import { useStableCallback } from '@/lib/use-stable-callback';

type RegisterItem<Key, Item> = (key: Key, item: Item) => () => void;

export interface ItemRegistry<Key, Item> {
  /** The snapshot published after the latest commit's registrations. */
  items: ReadonlyMap<Key, Item>;
  registerItem: RegisterItem<Key, Item>;
  /** The registry itself, including registrations whose snapshot hasn't been published yet. */
  liveItems: ReadonlyMap<Key, Item>;
}

/**
 * Collects item registrations into one immutable snapshot per React commit. Also returns the live registry, for reads
 * that must include the current commit's registrations before its snapshot is published.
 */
export function useItemRegistry<Key, Item>(): ItemRegistry<Key, Item> {
  const registryRef = React.useRef(new Map<Key, Item>());
  const [version, setVersion] = React.useState(0);

  // Items can register without their parent rendering, so each change asks the parent to render a new snapshot. Every
  // change made during one commit is batched into the same render, so the snapshot always has all of them.
  const registerItem = useStableCallback((key: Key, item: Item) => {
    registryRef.current.set(key, item);
    setVersion((current) => current + 1);
    return () => {
      registryRef.current.delete(key);
      setVersion((current) => current + 1);
    };
  });

  // Reading the ref while rendering is safe here: every change to it also changes `version`, which renders again.
  const items = React.useMemo(
    // eslint-disable-next-line react-hooks/refs
    () => new Map(registryRef.current),
    // The registry is mutated in place, so its version decides when to publish a copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  // eslint-disable-next-line react-hooks/refs
  const liveItems = registryRef.current;
  return React.useMemo(() => ({ items, registerItem, liveItems }), [items, registerItem, liveItems]);
}

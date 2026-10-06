import React, { useEffect, useRef, useState } from 'react';
import CTAButton from './CTAButton';

/** Presentation and an in-flight guard only; the screen owns session teardown. */
export default function LogoutButton({ onPress, testID }: { onPress: () => Promise<void>; testID: string }) {
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const press = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try { await onPress(); }
    finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return <CTAButton testID={testID} label="로그아웃" variant="logout"
    state={pending ? 'loading' : 'enabled'} onPress={() => void press()} />;
}

import { useEffect, useRef, useState } from 'react';
import { getApiErrorDisplayMessage } from '../../services/api/errorMapper';
import { requestEmailCode, verifyEmailCode, type EmailChallengeDto, type EmailProofDto, type EmailPurpose } from './api';

type Challenge = EmailChallengeDto & { receivedAt: number };
type Proof = EmailProofDto & { receivedAt: number };

export function useEmailVerification(email: string, purpose: EmailPurpose) {
  const key = `${purpose}:${email.trim().toLowerCase()}`;
  const current = useRef({ key, generation: 0 });
  if (current.current.key !== key) current.current = { key, generation: current.current.generation + 1 };
  const generation = current.current.generation;
  const mounted = useRef(true);
  const fence = useRef(false);
  const [state, setState] = useState<{ key: string; challenge: Challenge | null; proof: Proof | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setState(null); setCode(''); setError(null); setFieldError(null); }, [key]);
  const challenge = state?.key === key ? state.challenge : null;
  const proof = state?.key === key ? state.proof : null;
  useEffect(() => {
    if (!challenge && !proof) return;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [challenge, proof]);
  const remaining = (value: Challenge | Proof | null, until: string | undefined) => !value || !until ? 0 : Math.max(0,
    Math.ceil((Date.parse(until) - Date.parse(value.serverTime) - Math.max(0, clock - value.receivedAt)) / 1_000));
  const secondsLeft = remaining(challenge, challenge?.expiresAt);
  const resendSeconds = remaining(challenge, challenge?.resendAt);
  const proofSeconds = remaining(proof, proof?.expiresAt);
  const verificationToken = proof && proofSeconds > 0 ? proof.verificationToken : null;

  const run = async (work: () => Promise<void>) => {
    if (fence.current) return;
    fence.current = true;
    setBusy(true); setError(null); setFieldError(null);
    try { await work(); }
    catch (cause) { if (mounted.current && current.current.generation === generation) setError(cause); }
    finally { fence.current = false; if (mounted.current) setBusy(false); }
  };
  const request = () => run(async () => {
    // A resend attempt discards old local proof, even when the response is lost.
    setState(null); setCode('');
    const next = await requestEmailCode(email, purpose);
    if (!mounted.current || current.current.generation !== generation) return;
    const receivedAt = Date.now(); setClock(receivedAt);
    setState({ key, challenge: { ...next, receivedAt }, proof: null });
  });
  const verify = () => run(async () => {
    if (!challenge || !/^\d{6}$/.test(code)) { setFieldError('6자리 인증번호를 입력해주세요.'); return; }
    const next = await verifyEmailCode(email, purpose, challenge.challengeId, code);
    if (!mounted.current || current.current.generation !== generation) return;
    const receivedAt = Date.now(); setClock(receivedAt); setCode('');
    setState({ key, challenge, proof: { ...next, receivedAt } });
  });
  const clear = () => { setState(null); setCode(''); setError(null); setFieldError(null); };
  return { challenge, verificationToken, proofExpired: Boolean(proof && !verificationToken), busy, error: fieldError ?? (error ? getApiErrorDisplayMessage(error) : null), code,
    setCode, secondsLeft, resendSeconds, request, verify, clear };
}

import { useEffect, useRef, useState } from 'react';
import { getApiErrorCode, getApiErrorDisplayMessage } from '../../services/api/errorMapper';
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
  const [state, setState] = useState<{ key: string; challenge: Challenge | null; proof: Proof | null; requested: boolean; retryAt: number; codeBlocked: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<'request' | 'verify' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setState(null); setCode(''); setError(null); setFieldError(null); }, [key]);
  const hasRequested = state?.key === key && state.requested;
  const codeBlocked = state?.key === key && state.codeBlocked;
  const retryAt = state?.key === key ? state.retryAt : 0;
  const challenge = state?.key === key ? state.challenge : null;
  const proof = state?.key === key ? state.proof : null;
  useEffect(() => {
    if (!challenge && !proof && !retryAt) return;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [challenge, proof, retryAt]);
  const remaining = (value: Challenge | Proof | null, until: string | undefined) => !value || !until ? 0 : Math.max(0,
    Math.ceil((Date.parse(until) - Date.parse(value.serverTime) - Math.max(0, clock - value.receivedAt)) / 1_000));
  const secondsLeft = remaining(challenge, challenge?.expiresAt);
  const resendSeconds = Math.max(remaining(challenge, challenge?.resendAt), Math.max(0, Math.ceil((retryAt - clock) / 1_000)));
  const proofSeconds = remaining(proof, proof?.expiresAt);
  const verificationToken = proof && proofSeconds > 0 ? proof.verificationToken : null;

  const run = async (action: 'request' | 'verify', work: () => Promise<void>) => {
    if (fence.current) return;
    fence.current = true;
    setBusy(true); setBusyAction(action); setError(null); setFieldError(null);
    try { await work(); }
    catch (cause) { if (mounted.current && current.current.generation === generation) setError(cause); }
    finally { fence.current = false; if (mounted.current) { setBusy(false); setBusyAction(null); } }
  };
  const request = () => run('request', async () => {
    // A resend attempt discards old local proof, even when the response is lost.
    if (hasRequested && resendSeconds > 0) return;
    const startedAt = Date.now(); setClock(startedAt);
    setState({ key, requested: hasRequested, challenge, proof: null, codeBlocked: hasRequested, retryAt: hasRequested ? startedAt + 60_000 : 0 }); setCode('');
    const next = await requestEmailCode(email, purpose);
    if (!mounted.current || current.current.generation !== generation) return;
    const receivedAt = Date.now(); setClock(receivedAt);
    setState({ key, requested: true, challenge: { ...next, receivedAt }, proof: null, retryAt: 0, codeBlocked: false });
  });
  const verify = () => run('verify', async () => {
    if (!challenge || !/^\d{6}$/.test(code)) { setFieldError('6자리 인증번호를 입력해주세요.'); return; }
    if (!secondsLeft || codeBlocked) return;
    let next: EmailProofDto;
    try { next = await verifyEmailCode(email, purpose, challenge.challengeId, code); }
    catch (cause) {
      if (mounted.current && current.current.generation === generation
        && ['EMAIL_CODE_EXPIRED', 'EMAIL_CODE_EXHAUSTED'].includes(getApiErrorCode(cause) ?? '')) {
        setState((previous) => previous?.key === key ? { ...previous, codeBlocked: true } : previous);
      }
      throw cause;
    }
    if (!mounted.current || current.current.generation !== generation) return;
    const receivedAt = Date.now(); setClock(receivedAt); setCode('');
    setState({ key, requested: true, challenge, proof: { ...next, receivedAt }, retryAt: 0, codeBlocked: false });
  });
  const invalidate = () => {
    current.current.generation++;
    setState({ key, requested: true, challenge: null, proof: null, retryAt: 0, codeBlocked: false });
    setCode(''); setError(null); setFieldError('인증이 유효하지 않습니다. 인증번호를 재발송해 다시 인증해주세요.');
  };
  const clear = () => { setState(null); setCode(''); setError(null); setFieldError(null); };
  return { hasRequested, codeBlocked, challenge, verificationToken, proofExpired: Boolean(proof && !verificationToken), busy, busyAction, error: fieldError ?? (error ? getApiErrorDisplayMessage(error) : null), code,
    setCode, secondsLeft, resendSeconds, request, verify, clear, invalidate };
}

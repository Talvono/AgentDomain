'use client';

import { useState, useCallback, useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConnectWalletButton } from '@/components/wallet/connect-wallet-button';
import {
  Check,
  X,
  Loader2,
  ArrowRight,
  Sparkles,
  ExternalLink,
  ChevronDown,
  ShieldCheck,
  CircleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { cn, shortAddress } from '@/lib/utils';
import { useUsdcBalance } from '@/hooks/use-usdc-balance';
import { useRegisterAgent } from '@/hooks/use-register-agent';
import { useSiwe } from '@/hooks/use-siwe';
import { useRegistrationSnapshot, useRegistrationTracker } from './registration-tracker-provider';
import { TurnstileWidget } from '@/components/turnstile-widget';
import { toast } from 'sonner';
import {
  getBaseChainSwitchCopy,
  isBaseChainMismatchError,
  isBaseChainRequiredError,
} from '@/lib/base-chain';
import { useBaseChainGuard } from '@/hooks/use-base-chain';
import {
  ENTERPRISE_PLAN_OFFERS,
  PRIMARY_SUPPORTED_TLDS,
  SERVICE_PLAN_CATALOG,
} from '@agentdomain/shared/constants';
import type { ServicePlanKey, ServicePlanSku, SupportedTld } from '@agentdomain/shared';

const TLDS = PRIMARY_SUPPORTED_TLDS;
type Tld = (typeof TLDS)[number];

const COINBASE_BUY_USDC_URL = 'https://www.coinbase.com/buy/usdc';
const NEXORA_SWAP_URL = 'https://nexoraswap.rakibhq.xyz';
const QUOTE_TIMEOUT_MS = 90 * 1000;

type QuoteStatus = 'idle' | 'loading' | 'ready' | 'error' | 'expired';

interface AvailabilityResult {
  domain: string;
  available: boolean;
  reason?: string;
  premium?: boolean;
  priceUsd?: string;
  basename?: string;
  basenameAvailable?: boolean;
  basenameReason?: string;
  basenameCostUsdc?: string;
  ensName?: string;
  ensAvailable?: boolean;
  ensReason?: string;
  ensCostUsdc?: string;
  alternatives?: DomainAlternative[];
}

interface DomainAlternative {
  tld: Tld;
  domain: string;
  available: boolean;
  priceUsd: string;
  premium: boolean;
  priceSource: 'registrar' | 'fallback' | 'unknown';
}

interface QuoteResult {
  domainCostUsdc: string;
  basenameCostUsdc: string;
  ensCostUsdc: string;
  serviceFeeUsdc: string;
  platformFeeUsdc?: string;
  premiumPlan: ServicePlanKey;
  premiumPlanLabel: string;
  premiumPlanFeeUsdc: string;
  emailFeeUsdc: string;
  sslCertificationFeeUsdc: string;
  emailIncluded?: boolean;
  sslIncluded?: boolean;
  includedServices?: string[];
  totalUsdc: string;
}

export function RegisterFlow() {
  const { address, isConnected } = useAccount();
  const {
    effectiveChainId,
    isBaseChain,
    isSwitchingBase: switchingChain,
    ensureBaseChain,
  } = useBaseChainGuard();
  const {
    balanceAtomic,
    balanceNumber,
    balanceFormatted,
    isLoading: balanceLoading,
  } = useUsdcBalance(address, effectiveChainId);
  const { state: regState, register: submitRegister, reset: resetRegister } = useRegisterAgent();
  const { session, signIn, loading: signingIn, error: signInError } = useSiwe();
  const tracker = useRegistrationTracker();
  const tracking = useRegistrationSnapshot();
  const payerAuthenticated = Boolean(
    session.authenticated && address && session.address?.toLowerCase() === address.toLowerCase(),
  );

  const [name, setName] = useState('');
  const [searchedName, setSearchedName] = useState('');
  const [tld, setTld] = useState<SupportedTld>('xyz');
  const [registerBasename, setRegisterBasename] = useState(true);
  const [basenameLabel, setBasenameLabel] = useState('');
  const [registerEns, setRegisterEns] = useState(false);
  const [ensLabel, setEnsLabel] = useState('');
  const [emailUsername, setEmailUsername] = useState('agent');
  const [premiumPlan, setPremiumPlan] = useState<ServicePlanKey>('included');
  const [enterpriseSku, setEnterpriseSku] = useState<ServicePlanSku>('enterprise-100000');
  const premiumPlanSku: ServicePlanSku = premiumPlan === 'enterprise' ? enterpriseSku : premiumPlan;
  const [ownerAddressInput, setOwnerAddressInput] = useState('');
  const [years, setYears] = useState(1);
  const [autoRenew, setAutoRenew] = useState(false);

  const [availability, setAvailability] = useState<AvailabilityResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteStatus, setQuoteStatus] = useState<QuoteStatus>('idle');
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteFetchedAt, setQuoteFetchedAt] = useState<number | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [tldMenuOpen, setTldMenuOpen] = useState(false);
  const tldSelectorRef = useRef<HTMLDivElement>(null);
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const effectiveBasenameLabel = basenameLabel || name;
  const effectiveEnsLabel = ensLabel || name;
  const emailDomain = name ? `${name}.${tld}` : 'yourdomain.com';
  const emailPreview = `${emailUsername || 'agent'}@${emailDomain}`;

  const refreshSearch = useCallback(() => {
    if (name.length < 3) return;
    setSearchedName(name);
    setSearchNonce((value) => value + 1);
    setQuote(null);
    setQuoteStatus('loading');
    setQuoteError(null);
    setQuoteFetchedAt(null);
  }, [name]);

  useEffect(() => {
    if (!tldMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (tldSelectorRef.current && !tldSelectorRef.current.contains(event.target as Node | null)) {
        setTldMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTldMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [tldMenuOpen]);

  // Live availability check
  useEffect(() => {
    if (searchedName.length < 3) {
      setAvailability(null);
      setAvailabilityError(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    setAvailabilityError(null);
    const t = setTimeout(async () => {
      try {
        const query = new URLSearchParams({
          name: searchedName,
          tld,
          basenameLabel: registerBasename ? basenameLabel || searchedName : searchedName,
          ensLabel: registerEns ? ensLabel || searchedName : searchedName,
        });
        const res = await fetch(`/api/v1/domains/availability?${query.toString()}`);
        if (!res.ok) {
          if (!cancelled) {
            setAvailability({
              domain: `${searchedName}.${tld}`,
              available: false,
              reason: 'api_error',
            });
            setAvailabilityError('Availability check is unavailable. Search again in a moment.');
          }
          return;
        }
        const data = (await res.json()) as AvailabilityResult;
        if (!cancelled) {
          setAvailability(data);
          setAvailabilityError(null);
        }
      } catch {
        if (!cancelled) {
          setAvailability({
            domain: `${searchedName}.${tld}`,
            available: false,
            reason: 'network_error',
          });
          setAvailabilityError('Availability check timed out. Search again in a moment.');
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
      setChecking(false);
    };
  }, [searchedName, tld, basenameLabel, ensLabel, registerBasename, registerEns, searchNonce]);

  // Live quote
  useEffect(() => {
    if (searchedName.length < 3) {
      setQuote(null);
      setQuoteStatus('idle');
      setQuoteError(null);
      setQuoteFetchedAt(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);
    setQuote(null);
    setQuoteStatus('loading');
    setQuoteError(null);
    setQuoteFetchedAt(null);
    const query = new URLSearchParams({
      preferredName: searchedName,
      tld,
      registerBasename: String(registerBasename),
      basenameLabel: registerBasename ? basenameLabel || searchedName : searchedName,
      registerEns: String(registerEns),
      ensLabel: registerEns ? ensLabel || searchedName : searchedName,
      emailEnabled: 'true',
      emailUsername: emailUsername || 'agent',
      premiumPlan,
      premiumPlanSku,
      years: String(years),
    });
    fetch(`/api/v1/agents/quote?${query.toString()}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) {
          throw new Error('Price quote is unavailable.');
        }
        return (await r.json()) as QuoteResult;
      })
      .then((data) => {
        if (cancelled) return;
        if (data?.totalUsdc) {
          setQuote(data);
          setQuoteStatus('ready');
          setQuoteFetchedAt(Date.now());
          return;
        }
        setQuote(null);
        setQuoteStatus('error');
        setQuoteError('Price quote is unavailable. Search again to check price again.');
      })
      .catch(() => {
        if (cancelled) return;
        setQuote(null);
        setQuoteStatus('error');
        setQuoteError('Price quote is unavailable. Search again to check price again.');
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    searchedName,
    tld,
    registerBasename,
    registerEns,
    emailUsername,
    premiumPlan,
    premiumPlanSku,
    basenameLabel,
    ensLabel,
    years,
    searchNonce,
  ]);

  useEffect(() => {
    if (quoteStatus !== 'ready' || !quoteFetchedAt) return;
    const remainingMs = QUOTE_TIMEOUT_MS - (Date.now() - quoteFetchedAt);
    if (remainingMs <= 0) {
      setQuoteStatus('expired');
      return;
    }
    const timer = window.setTimeout(() => setQuoteStatus('expired'), remainingMs);
    return () => window.clearTimeout(timer);
  }, [quoteFetchedAt, quoteStatus]);

  const validName = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/.test(name);
  const validBasenameLabel = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/.test(effectiveBasenameLabel);
  const validEnsLabel = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/.test(effectiveEnsLabel);
  const validEmailUsername =
    /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/.test(emailUsername) &&
    !emailUsername.includes('..');
  const validOwnerAddress =
    !ownerAddressInput || /^0x[a-fA-F0-9]{40}$/.test(ownerAddressInput.trim());
  const isCurrentSearch = name === searchedName;
  const quoteHasDomainPrice = quote ? Number(quote.domainCostUsdc) > 0 : false;
  const quoteReady =
    quoteStatus === 'ready' && Boolean(quote) && isCurrentSearch && quoteHasDomainPrice;
  const paymentQuote =
    regState.phase !== 'idle' && regState.phase !== 'error' ? regState.payment : undefined;
  const showQuoteCard =
    Boolean(paymentQuote) ||
    (isCurrentSearch &&
      validName &&
      searchedName.length >= 3 &&
      (quoteStatus !== 'idle' || Boolean(quote)));
  const quoteRefreshMessage =
    quoteStatus === 'expired' ? 'Quote timed out. Search again to check price again.' : quoteError;
  const totalCost = quoteReady && quote ? Number(quote.totalUsdc) : 0;
  const isMainnet = isBaseChain;
  const suggestedAlternatives = useMemo(
    () => availability?.alternatives?.filter((alt) => alt.available) ?? [],
    [availability?.alternatives],
  );
  const basenameBlocked =
    registerBasename && (!validBasenameLabel || availability?.basenameAvailable === false);
  const ensBlocked = registerEns && (!validEnsLabel || availability?.ensAvailable === false);
  const insufficientBalance =
    isConnected &&
    isMainnet &&
    (paymentQuote
      ? balanceAtomic < BigInt(paymentQuote.amountAtomic)
      : totalCost > 0 && balanceNumber < totalCost);
  const wrongChain = isConnected && !isMainnet;
  const existingPurchase = Boolean(address && tracker.hasPurchase(address, `${name}.${tld}`));

  const canSubmit = useMemo(() => {
    if (!isConnected || !address) return false;
    if (!payerAuthenticated || tracking.connection !== 'ready' || existingPurchase) return false;
    if (wrongChain) return false;
    if (!validName || !availability?.available || checking) return false;
    if (!quoteReady) return false;
    if (!validOwnerAddress) return false;
    if (!validEmailUsername) return false;
    if (basenameBlocked) return false;
    if (ensBlocked) return false;
    if (turnstileSiteKey && !turnstileToken) return false;
    if (insufficientBalance) return false;
    if (regState.phase !== 'idle' && regState.phase !== 'error') return false;
    return true;
  }, [
    isConnected,
    address,
    wrongChain,
    validName,
    validOwnerAddress,
    validEmailUsername,
    availability,
    checking,
    quoteReady,
    basenameBlocked,
    ensBlocked,
    turnstileSiteKey,
    turnstileToken,
    insufficientBalance,
    regState.phase,
    payerAuthenticated,
    tracking.connection,
    existingPurchase,
  ]);

  const handleTurnstileToken = useCallback((token: string | null) => {
    setTurnstileToken(token);
  }, []);

  async function handleSwitchBaseMainnet() {
    await ensureBaseChain();
  }

  async function handleRegister() {
    if (wrongChain) {
      await handleSwitchBaseMainnet();
      return;
    }
    if (!quoteReady) {
      toast.error('Price quote expired', {
        description: 'Search again to re-check price before registering.',
      });
      return;
    }
    try {
      await submitRegister({
        preferredName: name,
        tld,
        registerBasename,
        basenameLabel: effectiveBasenameLabel,
        registerEns,
        ensLabel: effectiveEnsLabel,
        ownerAddress: ownerAddressInput.trim()
          ? (ownerAddressInput.trim() as `0x${string}`)
          : undefined,
        emailEnabled: true,
        emailUsername: emailUsername || 'agent',
        premiumPlan,
        premiumPlanSku,
        years,
        autoRenew,
        turnstileToken: turnstileToken ?? undefined,
      });
    } catch (e) {
      if (isBaseChainRequiredError(e) || isBaseChainMismatchError(e)) {
        const copy = getBaseChainSwitchCopy(e);
        toast.info(copy.title, { description: copy.description });
        return;
      }
      toast.info('Checkout not submitted', {
        description:
          'No payment request was submitted. Check your payer sign-in and registration updates before continuing.',
      });
    }
  }

  // Show success screen if registration completed
  if (regState.phase === 'success' && regState.result) {
    return (
      <SuccessScreen
        result={regState.result}
        autoRenew={autoRenew}
        onReset={() => {
          resetRegister();
          setName('');
          setBasenameLabel('');
          setEnsLabel('');
          setEmailUsername('agent');
          setPremiumPlan('included');
          setOwnerAddressInput('');
          setYears(1);
          setAutoRenew(false);
        }}
      />
    );
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      {isConnected && !payerAuthenticated && (
        <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Sign in before payment</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Use the paying wallet to keep access to your purchase progress. This sign-in does not
              authorize payment.
            </p>
            {signInError && (
              <p role="alert" className="mt-1 text-sm text-destructive">
                Sign-in was not completed. Please try again.
              </p>
            )}
          </div>
          <Button
            type="button"
            disabled={signingIn}
            onClick={async () => {
              if (await ensureBaseChain()) await signIn();
            }}
            className="shrink-0"
          >
            {signingIn ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            {signingIn ? 'Signing in...' : 'Sign in with paying wallet'}
          </Button>
        </div>
      )}
      {/* Wallet connection banner */}
      {!isConnected && (
        <Card className="premium-surface premium-elevated border-primary/35">
          <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="min-w-0">
              <div className="font-semibold flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Connect your wallet to begin
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                Your agent identity will be linked to the connected address.
              </div>
            </div>
            <ConnectWalletButton variant="gradient" className="w-full sm:w-auto" />
          </CardContent>
        </Card>
      )}

      {isConnected && address && (
        <div className="flex flex-col gap-2 px-1 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <div
              className={cn('h-2 w-2 rounded-full', isMainnet ? 'bg-green-900' : 'bg-destructive')}
            />
            <span className="shrink-0">Connected:</span>
            <span className="min-w-0 break-all font-mono text-foreground">
              {shortAddress(address)}
            </span>
          </div>
          <div className="text-muted-foreground">
            {wrongChain ? (
              <>
                Network: <span className="font-medium text-destructive">Base mainnet required</span>
              </>
            ) : (
              <>
                Balance:{' '}
                <span className={cn('font-mono', insufficientBalance && 'text-destructive')}>
                  {balanceLoading ? '...' : `$${Number(balanceFormatted).toFixed(2)} USDC`}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {wrongChain && (
        <div className="premium-surface rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <X className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              <div className="min-w-0">
                <div className="font-medium text-destructive">Switch to Base mainnet</div>
                <div className="mt-1 text-muted-foreground">
                  Registration and USDC payment only run on Base mainnet.
                </div>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleSwitchBaseMainnet()}
              disabled={switchingChain}
              className="w-full shrink-0 sm:w-auto"
            >
              {switchingChain ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Switch'}
            </Button>
          </div>
        </div>
      )}

      {/* Step 1: Name */}
      <Card className="premium-surface">
        <CardContent className="p-4 sm:p-6">
          <h2 className="mb-3 text-sm font-semibold">
            <label htmlFor="register-agent-name">1. Choose your name</label>
          </h2>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div ref={tldSelectorRef} className="min-w-0 flex-1">
              <div className="flex min-w-0 items-stretch overflow-hidden rounded-lg border border-input bg-background/70 shadow-inner shadow-black/10 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/60">
                <input
                  id="register-agent-name"
                  value={name}
                  onChange={(e) => {
                    const nextName = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                    setName(nextName);
                    if (availability) setAvailability(null);
                    if (nextName !== searchedName) {
                      setQuote(null);
                      setQuoteStatus('idle');
                      setQuoteError(null);
                      setQuoteFetchedAt(null);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      refreshSearch();
                    }
                  }}
                  placeholder="myagent"
                  className="w-0 min-w-0 flex-1 bg-transparent px-3 py-3 font-mono outline-none sm:px-4"
                  autoFocus
                  disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
                />
                <TldSelector
                  value={tld}
                  open={tldMenuOpen}
                  onOpenChange={setTldMenuOpen}
                  disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
                />
              </div>
              {tldMenuOpen && (
                <TldOptionsPanel
                  value={tld}
                  onChange={(nextTld) => {
                    setTld(nextTld);
                    setTldMenuOpen(false);
                  }}
                />
              )}
            </div>
            <Button
              onClick={refreshSearch}
              disabled={
                (regState.phase !== 'idle' && regState.phase !== 'error') ||
                name.length < 3 ||
                checking
              }
              className="h-12 px-6 sm:h-auto sm:self-start sm:py-3"
            >
              Search
            </Button>
          </div>
          {name && searchedName && name === searchedName && (
            <div className="mt-3 flex min-w-0 items-start gap-2 text-sm">
              {checking ? (
                <>
                  <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                  <span className="text-muted-foreground">Checking availability...</span>
                </>
              ) : !validName ? (
                <>
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <span className="text-destructive">Invalid name format</span>
                </>
              ) : availability?.available ? (
                <>
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-900" />
                  <span className="wrap-anywhere text-green-900">
                    {name}.{tld} is available
                    {availability.priceUsd && Number(availability.priceUsd) > 0
                      ? ` ($${availability.priceUsd})`
                      : ''}
                  </span>
                  {availability.premium && <Badge variant="warning">Premium</Badge>}
                </>
              ) : availability ? (
                <div>
                  <div className="flex min-w-0 items-start gap-2">
                    <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <span className="wrap-anywhere text-destructive">
                      {availabilityError ??
                        `${name}.${tld} is unavailable - try an alternative below`}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          )}
          {name && validName && registerBasename && availability?.basename && (
            <div className="mt-2 flex min-w-0 items-start gap-2 text-sm">
              {availability.basenameAvailable === false ? (
                <>
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <span className="wrap-anywhere text-destructive">
                    {availability.basename} is unavailable
                  </span>
                </>
              ) : availability.basenameAvailable === true ? (
                <>
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-900" />
                  <span className="wrap-anywhere text-green-900">
                    {availability.basename} is available
                    {availability.basenameCostUsdc ? ` ($${availability.basenameCostUsdc})` : ''}
                  </span>
                </>
              ) : null}
            </div>
          )}
          {name && validName && registerEns && availability?.ensName && (
            <div className="mt-2 flex min-w-0 items-start gap-2 text-sm">
              {availability.ensAvailable === false ? (
                <>
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <span className="wrap-anywhere text-destructive">
                    {availability.ensName} is unavailable
                  </span>
                </>
              ) : availability.ensAvailable === true ? (
                <>
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-900" />
                  <span className="wrap-anywhere text-green-900">
                    {availability.ensName} is available
                    {availability.ensCostUsdc ? ` ($${availability.ensCostUsdc})` : ''}
                  </span>
                </>
              ) : null}
            </div>
          )}
          {suggestedAlternatives.length > 0 && (
            <div className="premium-surface mt-4 rounded-lg border p-3">
              <div className="mb-2 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <span>Available alternatives</span>
                <span>Cheapest first</span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {suggestedAlternatives.map((alt, index) => (
                  <button
                    key={alt.domain}
                    type="button"
                    onClick={() => {
                      setTld(alt.tld);
                    }}
                    disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
                    className="interactive-surface group rounded-lg border border-border/60 bg-card/80 px-3 py-2 text-left disabled:pointer-events-none disabled:opacity-60"
                  >
                    <div className="flex items-center gap-2 font-mono text-sm text-foreground">
                      .{alt.tld}
                      {index === 0 && (
                        <span className="rounded-full border border-orange-700/20 bg-orange-600/10 px-2 py-0.5 text-[10px] font-sans text-orange-800">
                          Cheapest
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {alt.priceUsd ? `$${alt.priceUsd}` : 'See quote'}
                      {alt.premium ? ' premium' : ''}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step 2: Add-ons */}
      <Card className="premium-surface">
        <CardContent className="p-4 sm:p-6">
          <h2 className="mb-4 text-sm font-semibold">2. Choose your stack</h2>
          <div className="space-y-8">
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1">
                Registration
              </h3>
              <div
                className={cn(
                  'interactive-surface w-full flex flex-col gap-3 rounded-lg border px-4 py-3 text-left sm:flex-row sm:items-center sm:justify-between',
                  years > 1 ? 'border-primary/50 bg-primary/10' : 'border-border/50 bg-card/60',
                  regState.phase !== 'idle' &&
                    regState.phase !== 'error' &&
                    'opacity-60 cursor-not-allowed',
                )}
              >
                <div>
                  <label
                    htmlFor="register-years"
                    className="flex items-center gap-2 font-medium text-sm"
                  >
                    Registration Duration
                  </label>
                  <div
                    id="register-years-help"
                    className="text-xs text-muted-foreground font-mono mt-0.5"
                  >
                    Select how many years to register upfront
                  </div>
                </div>
                <div className="w-full flex-shrink-0 sm:w-auto">
                  <select
                    id="register-years"
                    aria-describedby="register-years-help"
                    value={years}
                    onChange={(e) => setYears(Number(e.target.value))}
                    disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
                    className="w-full rounded-md border border-input bg-background/70 px-3 py-2 text-sm font-medium text-foreground outline-none focus:ring-2 focus:ring-primary/50 cursor-pointer sm:w-auto sm:py-1.5"
                  >
                    {[1, 2, 3, 5, 10].map((y) => (
                      <option key={y} value={y} className="bg-background text-foreground">
                        {y} year{y > 1 ? 's' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <PremiumPlanSelector
                value={premiumPlan}
                onChange={setPremiumPlan}
                enterpriseSku={enterpriseSku}
                onEnterpriseSkuChange={setEnterpriseSku}
                disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
              />

              <Toggle
                label="Enable Auto-Renew"
                sublabel="After registration, authorize the owner-wallet RenewalVault switch and fund it with USDC"
                checked={autoRenew}
                onChange={setAutoRenew}
                disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
              />
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1">
                Web3 Identities
              </h3>
              <Toggle
                label="Basename on Base"
                sublabel={
                  effectiveBasenameLabel
                    ? `${effectiveBasenameLabel}.base.eth`
                    : 'yourname.base.eth'
                }
                recommended
                checked={registerBasename}
                onChange={setRegisterBasename}
                disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
              />
              {registerBasename && (
                <NameOverrideInput
                  label="Basename label"
                  suffix=".base.eth"
                  value={effectiveBasenameLabel}
                  placeholder={name || 'myagent'}
                  valid={validBasenameLabel}
                  onChange={(value) => setBasenameLabel(sanitizeLabel(value))}
                  onReset={() => setBasenameLabel('')}
                  disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
                />
              )}
              <Toggle
                label="ENS Name on Ethereum L1"
                sublabel={effectiveEnsLabel ? `${effectiveEnsLabel}.eth` : 'yourname.eth'}
                badge="Ethereum L1"
                checked={registerEns}
                onChange={setRegisterEns}
                disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
              />
              {registerEns && (
                <NameOverrideInput
                  label="ENS label"
                  suffix=".eth"
                  value={effectiveEnsLabel}
                  placeholder={name || 'myagent'}
                  valid={validEnsLabel}
                  onChange={(value) => setEnsLabel(sanitizeLabel(value))}
                  onReset={() => setEnsLabel('')}
                  disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
                />
              )}
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1">
                Advanced Features
              </h3>
              <EmailUsernameInput
                value={emailUsername}
                preview={emailPreview}
                valid={validEmailUsername}
                onChange={(value) => setEmailUsername(sanitizeEmailUsername(value))}
                onReset={() => setEmailUsername('agent')}
                disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
              />
              <AddressOverrideInput
                value={ownerAddressInput}
                valid={validOwnerAddress}
                connectedAddress={address}
                onChange={setOwnerAddressInput}
                disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Step 3: Quote */}
      {showQuoteCard && (
        <Card className="premium-surface premium-elevated border-primary/40">
          <CardContent className="p-4 sm:p-6">
            <h2 className="mb-4 text-sm font-semibold">3. Pricing</h2>
            {paymentQuote ? (
              <div className="space-y-2 text-sm">
                <Line
                  label="Payment total (USDC on Base)"
                  value={`${paymentQuote.amountUsdc} USDC`}
                  bold
                />
                <p className="text-muted-foreground">
                  {regState.paymentStatus === 'settled'
                    ? 'Payment settled. Registration updates are being checked.'
                    : regState.paymentStatus === 'refunded'
                      ? 'Payment refunded. Review registration updates.'
                      : regState.paymentStatus === 'not_charged'
                        ? 'Payment was not charged. Review registration updates.'
                        : regState.phase === 'awaiting-signature'
                          ? 'Awaiting your payment signature.'
                          : 'This is the signed amount. Settlement is not yet confirmed.'}
                </p>
              </div>
            ) : quoteStatus === 'loading' ? (
              <QuoteNotice
                tone="loading"
                title="Checking latest price..."
                message="Please wait while we refresh the live registrar and add-on pricing."
              />
            ) : quoteStatus === 'expired' || quoteStatus === 'error' || !quoteReady ? (
              <QuoteNotice
                tone="warning"
                title="Price check required"
                message={quoteRefreshMessage ?? 'Search again to check price again.'}
                actionLabel="Search again"
                onAction={refreshSearch}
              />
            ) : quote ? (
              <div className="space-y-2 text-sm">
                <p className="pb-1 text-xs text-muted-foreground">
                  {`One USDC payment on Base. Each priced line covers ${years} year${years === 1 ? '' : 's'}.`}
                </p>
                <Line
                  label={`Domain (.${tld})`}
                  value={
                    Number(quote.domainCostUsdc) > 0 ? `$${quote.domainCostUsdc}` : 'Checking...'
                  }
                />
                {registerBasename && (
                  <Line
                    label="Basename (includes gas estimate)"
                    value={`$${quote.basenameCostUsdc}`}
                  />
                )}
                {registerEns && (
                  <Line label="ENS (includes gas estimate)" value={`$${quote.ensCostUsdc}`} />
                )}
                <div>
                  <Line
                    label="Platform fee"
                    value={`$${quote.platformFeeUsdc ?? quote.serviceFeeUsdc}`}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Includes email inbox and DNS setup, SSL certification and the AgentID NFT mint.
                  </p>
                </div>
                {Number(quote.premiumPlanFeeUsdc) > 0 && (
                  <Line
                    label={`${quote.premiumPlanLabel} Premium Plan`}
                    value={`$${quote.premiumPlanFeeUsdc}`}
                  />
                )}
                <div className="border-t border-border/50 pt-3 mt-3">
                  <Line label="Total (USDC on Base)" value={`$${quote.totalUsdc}`} bold />
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      {/* Insufficient balance warning */}
      {insufficientBalance && (
        <Card className="premium-surface border-destructive/40">
          <CardContent className="flex items-start gap-3 px-4 pb-4 pt-4 text-sm sm:px-5 sm:pb-5 sm:pt-5">
            <X className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
            <div className="min-w-0 flex-1 space-y-2.5">
              <div className="font-medium leading-5 [overflow-wrap:anywhere]">
                You need {paymentQuote?.amountUsdc ?? quote?.totalUsdc} USDC but only have{' '}
                {balanceFormatted} USDC.
              </div>
              <div className="leading-5 text-muted-foreground">
                Add USDC to this wallet on Base mainnet, then refresh your balance.
              </div>
              <div className="flex flex-col gap-x-4 gap-y-2 pt-0.5 sm:flex-row sm:flex-wrap">
                <ExternalFundingLink href={COINBASE_BUY_USDC_URL}>
                  Buy USDC on Coinbase
                </ExternalFundingLink>
                <ExternalFundingLink href={NEXORA_SWAP_URL}>
                  Swap or bridge from other chains
                </ExternalFundingLink>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Status indicator during registration */}
      {(regState.phase === 'preparing' ||
        regState.phase === 'awaiting-signature' ||
        regState.phase === 'submitting' ||
        regState.phase === 'processing') && (
        <Card className="premium-surface border-primary/50">
          <CardContent
            role="status"
            className="flex min-h-12 items-center gap-3 px-4 py-3 sm:px-4 sm:py-3"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            <div className="min-h-6 min-w-0 break-words text-sm font-medium leading-6">
              {regState.phase === 'processing'
                ? regState.paymentStatus === 'settled'
                  ? 'Payment settled. Registration is processing.'
                  : regState.paymentStatus === 'refunded'
                    ? 'Payment refunded. Review registration updates.'
                    : regState.paymentStatus === 'not_charged'
                      ? 'Payment was not charged. Review registration updates.'
                      : 'Submission outcome is unconfirmed. Checking registration updates; do not pay again.'
                : (regState.message ?? 'Preparing checkout...')}
            </div>
          </CardContent>
        </Card>
      )}

      {regState.phase === 'error' && regState.error && (
        <Card className="border-destructive/60 bg-destructive/10">
          <CardContent className="p-4 text-sm text-destructive">
            <div className="font-semibold mb-1">
              {regState.rejectionCode ? 'Payment submission rejected' : 'Checkout not submitted'}
            </div>
            <div>{regState.error}</div>
          </CardContent>
        </Card>
      )}

      {regState.phase === 'action-required' && (
        <div
          role="status"
          className="flex items-start gap-3 border-l-2 border-amber-600 px-4 py-3 text-sm"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="min-w-0 space-y-1">
            <p className="font-semibold">Purchase needs review</p>
            <p className="break-words text-muted-foreground">{regState.message}</p>
            <a
              href="mailto:contact@agentdomain.app"
              className="inline-block text-primary underline"
            >
              Contact support
            </a>
          </div>
        </div>
      )}

      {(regState.phase === 'processing' || existingPurchase) &&
        regState.phase !== 'action-required' && (
          <p className="text-sm text-muted-foreground">
            This purchase is being tracked.{' '}
            <Link href="/dashboard" className="text-primary underline">
              View registration progress
            </Link>
            ; do not pay again.
          </p>
        )}

      {/* Step 4: Submit */}
      <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
        {turnstileSiteKey && isConnected && (
          <div className="w-full max-w-sm sm:mr-auto">
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              disabled={regState.phase !== 'idle' && regState.phase !== 'error'}
              onToken={handleTurnstileToken}
            />
          </div>
        )}
        {!isConnected ? (
          <ConnectWalletButton variant="gradient" size="xl" className="w-full sm:w-auto" />
        ) : (
          <Button
            variant="gradient"
            size="xl"
            disabled={
              regState.phase === 'action-required' || (wrongChain ? switchingChain : !canSubmit)
            }
            onClick={handleRegister}
            className="group w-full sm:w-auto"
          >
            {regState.phase === 'action-required' ? (
              <>
                <CircleAlert className="h-4 w-4" />
                Purchase needs review
              </>
            ) : regState.phase !== 'idle' && regState.phase !== 'error' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {regState.phase === 'awaiting-signature'
                  ? 'Awaiting signature...'
                  : regState.phase === 'submitting'
                    ? 'Submitting payment...'
                    : regState.phase === 'processing'
                      ? regState.paymentStatus === 'settled'
                        ? 'Processing registration...'
                        : 'Checking payment...'
                      : 'Preparing checkout...'}
              </>
            ) : !payerAuthenticated ? (
              'Sign in before paying'
            ) : existingPurchase ? (
              'Purchase already tracked'
            ) : tracking.connection !== 'ready' ? (
              'Waiting for registration updates'
            ) : wrongChain ? (
              switchingChain ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Switching...
                </>
              ) : (
                'Switch to Base mainnet'
              )
            ) : !validName || !availability?.available ? (
              availabilityError ? (
                'Search again in a moment'
              ) : (
                'Pick a valid available name'
              )
            ) : insufficientBalance ? (
              'Insufficient USDC balance'
            ) : !validOwnerAddress ? (
              'Fix owner address'
            ) : !validEmailUsername ? (
              'Fix email username'
            ) : registerBasename && !validBasenameLabel ? (
              'Fix Basename label'
            ) : basenameBlocked ? (
              'Basename unavailable'
            ) : registerEns && !validEnsLabel ? (
              'Fix ENS label'
            ) : ensBlocked ? (
              'ENS unavailable'
            ) : quoteStatus === 'loading' ? (
              'Checking price...'
            ) : !quoteReady ? (
              'Search again to check price'
            ) : turnstileSiteKey && !turnstileToken ? (
              'Complete spam check'
            ) : (
              <>
                Register agent identity
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function TldSelector({
  value,
  open,
  onOpenChange,
  disabled,
}: {
  value: SupportedTld;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex-shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        className="flex h-full min-w-[5.5rem] items-center justify-between gap-2 bg-card/70 px-2 py-3 font-mono text-sm text-foreground outline-none transition hover:bg-primary/10 focus:bg-primary/10 disabled:pointer-events-none disabled:opacity-60 sm:min-w-24 sm:px-3"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        .{value}
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>
    </div>
  );
}

function TldOptionsPanel({
  value,
  onChange,
}: {
  value: SupportedTld;
  onChange: (value: SupportedTld) => void;
}) {
  return (
    <div className="mt-2 flex justify-end">
      <div
        role="listbox"
        className="premium-surface w-full overflow-hidden rounded-lg border border-primary/30 p-1 shadow-[0_18px_36px_-24px_rgba(20,21,18,0.55)] sm:w-44"
      >
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Popular
        </div>
        {TLDS.map((item) => {
          const active = item === value;
          return (
            <button
              key={item}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => onChange(item)}
              className={cn(
                'flex w-full items-center justify-between rounded-lg px-3 py-2 font-mono text-sm transition',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-primary/15 hover:text-foreground',
              )}
            >
              .{item}
              {active && <Check className="h-3.5 w-3.5" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NameOverrideInput({
  label,
  suffix,
  value,
  placeholder,
  valid,
  onChange,
  onReset,
  disabled,
}: {
  label: string;
  suffix: string;
  value: string;
  placeholder: string;
  valid: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  return (
    <div className="premium-surface rounded-lg border p-3">
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <label htmlFor={inputId} className="text-xs font-semibold text-muted-foreground">
          {label}
        </label>
        <button
          type="button"
          onClick={onReset}
          disabled={disabled}
          className="text-xs text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
        >
          Use domain name
        </button>
      </div>
      <div
        className={cn(
          'flex min-w-0 flex-col items-stretch overflow-hidden rounded-md border border-input bg-background/70 shadow-inner shadow-black/10 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/60 sm:flex-row',
          value && !valid && 'border-destructive/70',
        )}
      >
        <input
          id={inputId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm outline-none"
          disabled={disabled}
        />
        <span className="flex items-center justify-center border-t border-border/40 bg-muted/40 px-3 py-2 font-mono text-sm text-muted-foreground sm:border-l sm:border-t-0">
          {suffix}
        </span>
      </div>
      {value && !valid && (
        <div className="mt-2 text-xs text-destructive">
          Use 3-63 lowercase letters, numbers, or hyphens. No leading or trailing hyphen.
        </div>
      )}
    </div>
  );
}

function EmailUsernameInput({
  value,
  preview,
  valid,
  onChange,
  onReset,
  disabled,
}: {
  value: string;
  preview: string;
  valid: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="premium-surface rounded-lg border p-3">
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <label
            htmlFor="register-email-username"
            className="text-xs font-semibold text-muted-foreground"
          >
            Primary email username
          </label>
          <div className="wrap-anywhere mt-0.5 font-mono text-xs text-muted-foreground">
            {preview}
          </div>
        </div>
        {value !== 'agent' && (
          <button
            type="button"
            onClick={onReset}
            disabled={disabled}
            className="text-xs text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
          >
            Use agent
          </button>
        )}
      </div>
      <input
        id="register-email-username"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="agent"
        className={cn(
          'w-full rounded-md border border-input bg-background/70 px-3 py-2 font-mono text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/60',
          !valid && 'border-destructive/70',
        )}
        disabled={disabled}
      />
      {!valid && (
        <div className="mt-2 text-xs text-destructive">
          Use 1-64 lowercase letters, numbers, dot, underscore, plus, or hyphen. No edge dots.
        </div>
      )}
      <div className="mt-2 text-xs leading-5 text-muted-foreground">
        Email and setup are included in the platform fee. You can change the primary address later.
      </div>
    </div>
  );
}

function PremiumPlanSelector({
  value,
  onChange,
  enterpriseSku,
  onEnterpriseSkuChange,
  disabled,
}: {
  value: ServicePlanKey;
  onChange: (value: ServicePlanKey) => void;
  enterpriseSku: ServicePlanSku;
  onEnterpriseSkuChange: (value: ServicePlanSku) => void;
  disabled?: boolean;
}) {
  const plans: ServicePlanKey[] = ['included', 'starter', 'pro', 'enterprise'];
  return (
    <div className="rounded-lg border border-border/60 bg-background/45 p-3 shadow-inner shadow-black/10">
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-sm font-medium">Premium Plan</div>
          <div className="text-xs text-muted-foreground">
            Select limits and registry privacy for this agent.
          </div>
        </div>
        <div className="text-xs text-muted-foreground">Aligned with registration duration</div>
      </div>
      <div className="grid gap-2 md:grid-cols-4">
        {plans.map((plan) => {
          const entry = SERVICE_PLAN_CATALOG[plan];
          const selected = value === plan;
          return (
            <button
              key={plan}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(plan)}
              disabled={disabled}
              className={cn(
                'min-h-[142px] rounded-lg border p-3 text-left transition-colors disabled:pointer-events-none disabled:opacity-60',
                selected
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-border/60 bg-card/60 hover:border-primary/35',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">{entry.label}</div>
                {selected && <Check className="h-4 w-4 text-primary" />}
              </div>
              <div className="mt-1 font-mono text-sm">
                {entry.yearlyPriceUsdcAtomic === 0n
                  ? 'Included'
                  : `$${formatPlanPrice(entry.yearlyPriceUsdcAtomic)}/year`}
              </div>
              <div className="mt-2 text-xs leading-5 text-muted-foreground">
                {entry.limits.monthlyEmails.toLocaleString()} emails/month (sent + received),{' '}
                {entry.limits.apiKeys} API key{entry.limits.apiKeys === 1 ? '' : 's'},{' '}
                {entry.limits.emailAliases > 0
                  ? `${entry.limits.emailAliases} aliases.`
                  : 'primary email only.'}
              </div>
              {plan !== 'included' && (
                <div className="mt-2 text-xs font-medium text-primary">
                  Registry privacy included
                </div>
              )}
            </button>
          );
        })}
      </div>
      {value === 'enterprise' && (
        <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <label htmlFor="register-enterprise-sku" className="text-xs font-medium">
            Enterprise email volume
          </label>
          <select
            id="register-enterprise-sku"
            value={enterpriseSku}
            onChange={(event) => onEnterpriseSkuChange(event.target.value as ServicePlanSku)}
            disabled={disabled}
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs sm:w-auto"
          >
            {ENTERPRISE_PLAN_OFFERS.map((offer) => (
              <option key={offer.sku} value={offer.sku}>
                {offer.monthlyEmails.toLocaleString()} emails/month · $
                {Number(offer.yearlyPriceUsdcAtomic / 1_000_000n).toLocaleString()}/year
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function AddressOverrideInput({
  value,
  valid,
  connectedAddress,
  onChange,
  disabled,
}: {
  value: string;
  valid: boolean;
  connectedAddress?: `0x${string}`;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="premium-surface rounded-lg border p-3">
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <label
            htmlFor="register-owner-address"
            className="text-xs font-semibold text-muted-foreground"
          >
            Deliver identity to
          </label>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Leave empty to use connected wallet
            {connectedAddress ? ` (${shortAddress(connectedAddress)})` : ''}.
          </div>
        </div>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            disabled={disabled}
            className="text-xs text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
          >
            Use connected
          </button>
        )}
      </div>
      <input
        id="register-owner-address"
        value={value}
        onChange={(event) => onChange(event.target.value.trim())}
        placeholder="0x agent wallet address (optional)"
        className={cn(
          'w-full rounded-md border border-input bg-background/70 px-3 py-2 font-mono text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/60',
          value && !valid && 'border-destructive/70',
        )}
        disabled={disabled}
      />
      {value && !valid && (
        <div className="mt-2 text-xs text-destructive">Enter a valid EVM address.</div>
      )}
    </div>
  );
}

function sanitizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function sanitizeEmailUsername(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._+-]/g, '')
    .slice(0, 64);
}

function ExternalFundingLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function SuccessScreen({
  result,
  autoRenew,
  onReset,
}: {
  result: NonNullable<ReturnType<typeof useRegisterAgent>['state']['result']>;
  autoRenew: boolean;
  onReset: () => void;
}) {
  return (
    <Card className="premium-surface premium-elevated border-primary/20">
      <CardContent className="p-4 text-center sm:p-8">
        <div className="mb-6 inline-flex h-16 w-16 items-center justify-center rounded-full border border-green-900/20 bg-green-900/10">
          <Check className="h-8 w-8 text-green-900" />
        </div>
        <h2 className="text-2xl font-bold mb-2">Identity registered!</h2>
        <p className="wrap-anywhere mb-6 text-muted-foreground">
          {result.domain} registration is complete.
        </p>

        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button onClick={onReset} className="w-full sm:w-auto">
            Register another
          </Button>
          {result.agentId && (
            <Link href={`/agents/${encodeURIComponent(result.agentId)}`}>
              <Button variant="secondary" className="w-full sm:w-auto">
                Manage renewal
              </Button>
            </Link>
          )}
        </div>

        {autoRenew && (
          <div className="mt-6 border-t border-border/40 pt-6">
            <div className="text-sm text-muted-foreground">
              You selected <strong>Enable Auto-Renew</strong>. Since only the domain owner can
              enable this, open renewal management to authorize it on-chain.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuoteNotice({
  title,
  message,
  tone,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  tone: 'loading' | 'warning';
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        tone === 'loading'
          ? 'border-primary/20 bg-primary/5'
          : 'border-amber-900/20 bg-amber-900/10',
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <div className="mt-1 text-sm text-muted-foreground">{message}</div>
        </div>
        {actionLabel && onAction && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onAction}
            className="w-full sm:w-auto"
          >
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

function Toggle({
  label,
  sublabel,
  checked,
  onChange,
  recommended,
  badge,
  disabled,
}: {
  label: string;
  sublabel?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  recommended?: boolean;
  badge?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'interactive-surface flex w-full flex-col gap-3 rounded-lg border px-4 py-3 text-left sm:flex-row sm:items-start sm:justify-between sm:gap-4',
        checked ? 'border-primary/50 bg-primary/10' : 'border-border/50 bg-card/60',
        disabled && 'opacity-60 cursor-not-allowed',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 font-medium text-sm">
          {label}
          {recommended && <Badge variant="success">Recommended</Badge>}
          {badge && <Badge variant="secondary">{badge}</Badge>}
        </div>
        {sublabel && (
          <div className="wrap-anywhere mt-0.5 text-xs font-mono text-muted-foreground">
            {sublabel}
          </div>
        )}
      </div>
      <div
        className={cn(
          'h-6 w-11 flex-shrink-0 self-end rounded-full p-0.5 transition-colors sm:self-start',
          checked ? 'bg-primary shadow-lg shadow-primary/20' : 'bg-muted/90',
        )}
      >
        <div
          className={cn(
            'h-5 w-5 rounded-full bg-background transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </div>
    </button>
  );
}

function Line({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className={cn('text-muted-foreground', bold && 'text-foreground font-semibold')}>
        {label}
      </span>
      <span
        className={cn(
          'min-w-0 font-mono [overflow-wrap:anywhere] sm:max-w-[65%] sm:text-right',
          bold && 'text-lg font-semibold',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function formatPlanPrice(atomic: bigint) {
  const whole = atomic / 1_000_000n;
  const fraction = atomic % 1_000_000n;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

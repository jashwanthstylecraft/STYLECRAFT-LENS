"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { Loader2, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { gsap } from "gsap";
import { useAuthStore } from "@/stores/authStore";
import { Logo, Wordmark } from "@/components/ui/Logo";
import BackgroundStage from "@/components/scroll/BackgroundStage";
import ScrollProgressBar from "@/components/scroll/ScrollProgressBar";

// Small cursor-tilt on the glass card, only while the cinematic hero video
// plays behind it — skipped entirely under prefers-reduced-motion (a static
// card is the correct "reduced motion" state, not a tilt with no easing).
const MAX_TILT_DEG = 3;

function useCardTilt<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    gsap.set(el, { transformPerspective: 800 });
    const quickX = gsap.quickTo(el, "rotateX", { duration: 0.4, ease: "power3.out" });
    const quickY = gsap.quickTo(el, "rotateY", { duration: 0.4, ease: "power3.out" });

    function onPointerMove(e: PointerEvent) {
      const rect = el!.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      quickY(px * MAX_TILT_DEG * 2);
      quickX(-py * MAX_TILT_DEG * 2);
    }
    function onPointerLeave() {
      quickX(0);
      quickY(0);
    }

    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerleave", onPointerLeave);
    return () => {
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return ref;
}

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { fetchSession } = useAuthStore();
  const cardRef = useCardTilt<HTMLDivElement>();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;

    setLoading(true);
    try {
      // Goes through our own server route (not supabase.auth.signInWithPassword
      // directly) so failed attempts can be rate-limited and audit-logged —
      // see app/api/auth/login/route.ts. It sets the same session cookies
      // a direct client-side call would have.
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Incorrect email or password");
        return;
      }

      await fetchSession();
      const redirect = searchParams.get("redirect") || "/dashboard";
      router.push(redirect);
    } catch (err) {
      toast.error("Failed to sign in — try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      ref={cardRef}
      style={{ transformStyle: "preserve-3d" }}
      className="w-full max-w-sm p-6 md:p-8 bg-surface-2 border border-border rounded-2xl shadow-2xl relative overflow-hidden text-xs space-y-6"
    >
      <div className="absolute -top-24 -left-24 w-48 h-48 rounded-full bg-accent/15 blur-3xl" />

      <div className="flex flex-col items-center space-y-2 relative z-10 text-center">
        <Logo size="md" />
        <Wordmark className="text-xl text-text-primary mt-3" />
        <p className="text-text-muted leading-normal max-w-xs">
          Know your competition. Own your market. AI-powered competitive intelligence SaaS.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3 relative z-10">
        <div className="space-y-1">
          <label className="font-semibold text-text-primary block">Email</label>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent placeholder-text-muted"
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="font-semibold text-text-primary block">Password</label>
            <Link href="/forgot-password" className="text-accent hover:underline">Forgot password?</Link>
          </div>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent placeholder-text-muted"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 bg-accent hover:bg-accent-hover text-white text-xs font-bold rounded-xl transition-colors flex items-center justify-center gap-1.5 shadow shadow-accent/25 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <span>Sign in</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}

export default function SignInPage() {
  return (
    <div className="relative flex items-center justify-center min-h-screen bg-bg text-text-primary px-4 overflow-hidden">
      <ScrollProgressBar />
      <BackgroundStage />

      <div className="relative z-[1] w-full flex items-center justify-center">
        <Suspense fallback={null}>
          <SignInForm />
        </Suspense>
      </div>
    </div>
  );
}

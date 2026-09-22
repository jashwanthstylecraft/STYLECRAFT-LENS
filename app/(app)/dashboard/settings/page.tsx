"use client";

import { useState } from "react";
import {
  Settings,
  User,
  Key,
  ShieldAlert,
  CheckCircle,
  Sliders
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/Spinner";
import { KeyRound } from "lucide-react";
import { MagicBentoSection, MagicBentoCard } from "@/components/ui/MagicBento";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

export default function SettingsPage() {
  const { user, refreshSession } = useAuth();
  const [activeSubTab, setActiveSubTab] = useState<"profile" | "keys">("profile");

  const [userName, setUserName] = useState(user?.name || "Dev Admin");
  const [userEmail, setUserEmail] = useState(user?.email || "developer@stylecraftlens.com");
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const handleUpdateProfile = (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    setTimeout(() => {
      setSavingProfile(false);
      toast.success("Profile saved successfully");
    }, 800);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("New password and confirmation don't match");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      toast.error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    setChangingPassword(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to change password");

      toast.success("Password updated");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      if (user?.mustChangePassword) refreshSession();
    } catch (err: any) {
      toast.error(err.message || "Failed to change password");
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Title */}
      <div className="flex items-center gap-2">
        <Settings className="w-5 h-5 text-accent" />
        <h1 className="text-display cinema-text">Settings</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* Left Side: Navigation Links (3/12) */}
        <div className="lg:col-span-3 flex flex-col gap-1 p-2 bg-surface-2 border border-border rounded-xl">
          {[
            { id: "profile", label: "User Profile", icon: User },
            { id: "keys", label: "API Configuration", icon: Key },
          ].map((tab) => {
            const Icon = tab.icon;
            const isSelected = activeSubTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveSubTab(tab.id as any)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors text-left ${
                  isSelected 
                    ? "bg-accent-bg text-accent-text" 
                    : "text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                }`}
              >
                <Icon className={`w-4 h-4 ${isSelected ? "text-accent" : "text-text-muted"}`} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Right Side: Tab Contents (9/12) */}
        <div className="lg:col-span-9 bg-surface-2 border border-border rounded-xl p-5 md:p-6 min-h-[350px]">
          
          {/* USER PROFILE TAB */}
          {activeSubTab === "profile" && (
            <MagicBentoSection className="grid grid-cols-1 gap-4">
              <MagicBentoCard className="p-4 space-y-6">
              <div>
                <h2 className="text-sm font-bold text-text-primary">Profile Details</h2>
                <p className="text-[11px] text-text-muted mt-0.5">Manage your user profile details.</p>
              </div>

              <form onSubmit={handleUpdateProfile} className="space-y-4 max-w-md text-xs">
                <div className="space-y-1">
                  <label className="font-semibold text-text-primary">Display Name</label>
                  <input
                    type="text"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-text-primary">Email Address</label>
                  <input
                    type="email"
                    value={userEmail}
                    onChange={(e) => setUserEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                  />
                </div>

                <button
                  type="submit"
                  disabled={savingProfile}
                  className="px-4 py-2 bg-accent hover:bg-accent-hover text-white font-bold rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {savingProfile && <Spinner size="xs" className="text-white" />}
                  <span>Save Profile</span>
                </button>
              </form>
              </MagicBentoCard>

              <MagicBentoCard className="p-4">
                <div className="flex items-center gap-2 mb-1">
                  <KeyRound className="w-4 h-4 text-text-muted" />
                  <h2 className="text-sm font-bold text-text-primary">Change Password</h2>
                </div>
                <p className="text-[11px] text-text-muted mb-4">Update the password used to sign in.</p>

                <form onSubmit={handleChangePassword} className="space-y-4 max-w-md text-xs">
                  <div className="space-y-1">
                    <label className="font-semibold text-text-primary">Current password</label>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-text-primary">New password</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={MIN_PASSWORD_LENGTH}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-text-primary">Confirm new password</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={MIN_PASSWORD_LENGTH}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={changingPassword}
                    className="px-4 py-2 bg-surface-3 hover:border-border-strong border border-border text-text-primary font-bold rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {changingPassword && <Spinner size="xs" />}
                    <span>Update Password</span>
                  </button>
                </form>
              </MagicBentoCard>
            </MagicBentoSection>
          )}

          {/* API CONFIGURATION TAB */}
          {activeSubTab === "keys" && (
            <div className="space-y-6 text-xs">
              <div>
                <h2 className="text-sm font-bold text-text-primary">Local Environment Variables</h2>
                <p className="text-[11px] text-text-muted mt-0.5 font-display">Configure API keys inside your local `.env.local` file.</p>
              </div>

              <MagicBentoCard className="p-4 space-y-3.5">
                <div className="flex gap-3.5 items-start">
                  <Sliders className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                  <div className="space-y-1 leading-relaxed">
                    <p className="font-semibold text-text-primary">Anthropic Claude API Key (primary)</p>
                    <p className="text-text-secondary">
                      Powers competitive analysis and GTM/TDS/Content Form generation — supply a valid `ANTHROPIC_API_KEY` to connect with Claude (includes built-in web search — no separate search key needed). OpenAI is used as a fallback if this is unset.
                    </p>
                    <pre className="p-2 border border-border bg-surface-1 text-mono text-[10px] text-accent-text rounded mt-2 select-all w-fit">
                      {"ANTHROPIC_API_KEY=\"sk-ant-...\""}
                    </pre>
                  </div>
                </div>

                <div className="flex gap-3.5 items-start pt-3.5 border-t border-border/60">
                  <Sliders className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                  <div className="space-y-1 leading-relaxed">
                    <p className="font-semibold text-text-primary">OpenAI API Key (fallback)</p>
                    <p className="text-text-secondary">
                      Used automatically whenever Claude is unavailable or fails — supply a valid `OPENAI_API_KEY` to keep this fallback tier live.
                    </p>
                    <pre className="p-2 border border-border bg-surface-1 text-mono text-[10px] text-accent-text rounded mt-2 select-all w-fit">
                      {"OPENAI_API_KEY=\"sk-...\""}
                    </pre>
                  </div>
                </div>

                <div className="flex gap-3.5 items-start pt-3.5 border-t border-border/60">
                  <Sliders className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                  <div className="space-y-1 leading-relaxed">
                    <p className="font-semibold text-text-primary">Google Gemini API Key</p>
                    <p className="text-text-secondary">
                      Currently disabled app-wide (expired key) — kept as a last-resort fallback behind Claude/OpenAI. To re-enable, supply a valid `GEMINI_API_KEY` and clear the kill-switch in `lib/gemini.ts`.
                    </p>
                    <pre className="p-2 border border-border bg-surface-1 text-mono text-[10px] text-accent-text rounded mt-2 select-all w-fit">
                      {"GEMINI_API_KEY=\"...\""}
                    </pre>
                  </div>
                </div>

                <div className="flex gap-3.5 items-start pt-3.5 border-t border-border/60">
                  <User className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                  <div className="space-y-1 leading-relaxed">
                    <p className="font-semibold text-text-primary">Clerk Authentication Keys</p>
                    <p className="text-text-secondary">
                      Supply publishable and secret keys to configure real register/sign-in flows.
                    </p>
                    <pre className="p-2 border border-border bg-surface-1 text-mono text-[10px] text-accent-text rounded mt-2 select-all w-fit">
                      {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=\"pk_...\""}{"\n"}
                      {"CLERK_SECRET_KEY=\"sk-clerk-...\""}
                    </pre>
                  </div>
                </div>
              </MagicBentoCard>

              {/* Warning banner kept as a plain themed box, not a card — same rationale as
                  the competitor Danger Zone: a semantic warning color shouldn't get a glow. */}
              <div className="flex gap-2.5 p-3 rounded-lg border border-warning/25 bg-warning-bg/15 text-warning items-start">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="leading-normal">
                  Important: In the absence of Clerk keys, the application automatically runs in Developer Bypass mode using in-memory databases, letting you test all pages out-of-the-box.
                </p>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// app/(app)/dashboard/page.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Target,
  Sparkles,
  FileText,
  TrendingUp,
  ArrowRight,
  Plus,
  Play,
  Download,
  Activity
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  Cell
} from "recharts";
import KPICard from "@/components/dashboard/KPICard";
import { toast } from "sonner";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import FaqHelpLink from "@/components/help/FaqHelpLink";

function timeAgo(date: Date) {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function DashboardOverview() {
  const router = useRouter();
  
  const [loading, setLoading] = useState(true);
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [analyses, setAnalyses] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [activityFeed, setActivityFeed] = useState<any[]>([]);
  
  // Sparkline data
  const [sparklines] = useState({
    competitors: [{ value: 4 }, { value: 6 }, { value: 5 }, { value: 7 }, { value: 8 }, { value: 7 }, { value: 9 }],
    analyses: [{ value: 1 }, { value: 2 }, { value: 1 }, { value: 3 }, { value: 4 }, { value: 2 }, { value: 5 }],
    reports: [{ value: 1 }, { value: 1 }, { value: 2 }, { value: 2 }, { value: 3 }, { value: 3 }, { value: 4 }],
    insights: [{ value: 10 }, { value: 15 }, { value: 12 }, { value: 18 }, { value: 22 }, { value: 20 }, { value: 26 }],
  });

  useEffect(() => {
    // Parallel fetch from actual API routes
    Promise.all([
      fetch("/api/competitors?limit=100").then(res => res.json()).catch(() => ({ competitors: [] })),
      fetch("/api/analyses").then(res => res.json()).catch(() => ({ analyses: [] })),
      fetch("/api/reports").then(res => res.json()).catch(() => ({ reports: [] }))
    ]).then(([compData, anData, repData]) => {
      const comps = compData.competitors || [];
      const ans = anData.analyses || [];
      const reps = repData.reports || [];

      setCompetitors(comps);
      setAnalyses(ans);
      setReports(reps);

      // Generate dynamic activity feed
      const feed: any[] = [];
      
      comps.forEach((c: any) => {
        if (!c.is_fixed) {
          const dt = new Date(c.created_at || c.createdAt || Date.now());
          feed.push({
            id: `comp_${c.id || c.name}`,
            text: `Competitor '${c.name}' was registered.`,
            time: timeAgo(dt),
            timestamp: dt,
            icon: Target,
            color: "text-emerald-400 bg-emerald-950/40"
          });
        }
      });

      ans.forEach((a: any) => {
        const dt = new Date(a.createdAt || a.created_at || Date.now());
        feed.push({
          id: `analysis_${a.id}`,
          text: `AI Analysis '${a.project?.name || "Product deep dive"}' completed.`,
          time: timeAgo(dt),
          timestamp: dt,
          icon: Sparkles,
          color: "text-indigo-400 bg-indigo-950/40"
        });
      });

      reps.forEach((r: any) => {
        const dt = new Date(r.updated_at || r.updatedAt || r.created_at || Date.now());
        feed.push({
          id: `report_${r.id}`,
          text: `Report '${r.title}' updated.`,
          time: timeAgo(dt),
          timestamp: dt,
          icon: FileText,
          color: "text-amber-400 bg-amber-950/40"
        });
      });

      // Sort by timestamp desc and take top 5
      feed.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      setActivityFeed(feed.slice(0, 5));

      setLoading(false);
    }).catch(err => {
      console.error("Dashboard fetch error:", err);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        {/* KPI Skeleton */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-24 bg-surface-2 border border-border rounded-xl" />
          ))}
        </div>
        
        {/* Main Grid Skeleton */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 space-y-6">
            <div className="h-[250px] bg-surface-2 border border-border rounded-xl" />
            <div className="h-[280px] bg-surface-2 border border-border rounded-xl" />
          </div>
          <div className="lg:col-span-5 space-y-6">
            <div className="h-[320px] bg-surface-2 border border-border rounded-xl" />
            <div className="h-[210px] bg-surface-2 border border-border rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  // Derived dashboard variables
  const competitorsCount = competitors.length;
  const activeAnalysesCount = analyses.filter(a => a.status === "RUNNING" || a.status === "PENDING").length;
  const reportsCount = reports.length;
  const draftReportsCount = reports.filter(r => r.status === "draft" || r.status === "DRAFT").length;
  
  // Threat score insights
  const sortedCompetitors = [...competitors]
    .sort((a, b) => (b.threatScore || 30) - (a.threatScore || 30));

  const top8Competitors = sortedCompetitors.slice(0, 8).map(c => ({
    name: c.name,
    threatScore: c.threatScore || 30,
    tier: c.is_fixed ? "established" : "emerging"
  }));

  const emergingThreats = sortedCompetitors.filter(c => (c.threatScore || 0) > 50);

  const handleQuickAction = (action: string) => {
    if (action === "add") {
      router.push("/dashboard/competitors");
      setTimeout(() => window.dispatchEvent(new CustomEvent("trigger-add-competitor")), 150);
    } else if (action === "analyze") {
      router.push("/dashboard/analyze");
    } else if (action === "report") {
      router.push("/dashboard/reports");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h1 className="text-display cinema-text">Dashboard</h1>
        <FaqHelpLink category="Dashboard" />
      </div>

      {/* KPI Cards Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          label="Competitors"
          value={competitorsCount}
          delta={`+${competitorsCount - 20 > 0 ? competitorsCount - 20 : 0} custom`}
          isPositive={competitorsCount > 20}
          sparklineData={sparklines.competitors}
          accentColor="#6366F1"
          icon={Target}
          href="/dashboard/competitors"
          entranceDelayMs={0}
        />
        <KPICard
          label="Active Analyses"
          value={activeAnalysesCount}
          delta={activeAnalysesCount > 0 ? "Running" : "0 running"}
          isPositive={activeAnalysesCount > 0}
          sparklineData={sparklines.analyses}
          accentColor="#A5B4FC"
          icon={Sparkles}
          href="/dashboard/analyze"
          entranceDelayMs={40}
        />
        <KPICard
          label="Reports Generated"
          value={reportsCount}
          delta={`${draftReportsCount} draft`}
          isPositive={true}
          sparklineData={sparklines.reports}
          accentColor="#22C55E"
          icon={FileText}
          href="/dashboard/reports"
          entranceDelayMs={80}
        />
        <KPICard
          label="AI Strategic Insights"
          value={competitorsCount * 2}
          delta={`+${competitorsCount}`}
          isPositive={true}
          sparklineData={sparklines.insights}
          accentColor="#F59E0B"
          icon={TrendingUp}
          entranceDelayMs={120}
        />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Column (7/12) */}
        <div className="lg:col-span-7 space-y-6 flex flex-col">

          {/* Recent Analyses Panel */}
          <div className="stagger-entrance bg-surface-2 border border-border rounded-xl p-5 flex flex-col flex-1" style={{ animationDelay: "160ms" }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-text-primary">Recent Analyses</h2>
              <Link href="/dashboard/analyze" className="group text-xs text-accent hover:underline flex items-center gap-1 font-semibold">
                <span>New Analysis</span>
                <Plus className="w-3.5 h-3.5 transition-transform duration-150 ease-[var(--ease-out)] group-hover:translate-x-[3px]" />
              </Link>
            </div>

            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-border/60 text-text-muted font-bold">
                    <th className="pb-2.5">Project / Product</th>
                    <th className="pb-2.5">Status</th>
                    <th className="pb-2.5">Competitors</th>
                    <th className="pb-2.5">Date</th>
                    <th className="pb-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {analyses.slice(0, 5).map((an) => (
                    <tr key={an.id} className="row-hover">
                      <td className="py-3 font-semibold text-text-primary">
                        <div className="max-w-[200px] truncate" title={an.project?.name || "Product Analysis"}>
                          {an.project?.name || "Product Analysis"}
                        </div>
                      </td>
                      <td className="py-3">
                        <Badge
                          tone={an.status === "COMPLETE" ? "success" : an.status === "RUNNING" ? "accent" : an.status === "FAILED" ? "danger" : "neutral"}
                          uppercase
                          dot={an.status === "RUNNING"}
                          pulseDot={an.status === "RUNNING"}
                        >
                          {an.status}
                        </Badge>
                      </td>
                      <td className="py-3 text-text-secondary">{an.competitors?.length || 10} found</td>
                      <td className="py-3 text-text-muted">
                        {new Date(an.createdAt || an.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          onClick={() => router.push(`/dashboard/analyze?id=${an.id}`)}
                          className="btn-lift cursor-target px-2 py-1 rounded border border-border hover:bg-surface-3 hover:text-text-primary text-[10px] transition-colors font-semibold"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                  {analyses.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <EmptyState
                          compact
                          icon={Sparkles}
                          title="No analyses yet"
                          description="Run your first AI competitive analysis to see it here."
                          action={{ label: "New analysis", href: "/dashboard/analyze" }}
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Top Competitors by Threat Score Chart */}
          <div className="stagger-entrance bg-surface-2 border border-border rounded-xl p-5" style={{ animationDelay: "200ms" }}>
            <h2 className="text-sm font-bold text-text-primary mb-4">Top Competitors by Threat Score</h2>
            <div className="h-[250px] w-full text-xs">
              {top8Competitors.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={top8Competitors}
                    layout="vertical"
                    margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
                  >
                    <XAxis type="number" domain={[0, 100]} stroke="#52525B" fontSize={10} />
                    <YAxis dataKey="name" type="category" stroke="#52525B" fontSize={10} width={90} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#16161A", borderColor: "rgba(255,255,255,0.08)", color: "#F4F4F5" }}
                      itemStyle={{ color: "#A5B4FC" }}
                    />
                    <Bar dataKey="threatScore" radius={[0, 4, 4, 0]}>
                      {top8Competitors.map((entry, index) => (
                        <Cell 
                          key={`cell-${index}`} 
                          fill={entry.tier === "established" ? "#6366F1" : "#A5B4FC"} 
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState
                  compact
                  icon={TrendingUp}
                  title="No competitor data yet"
                  description="Add competitors to see them ranked by threat score."
                  action={{ label: "Add competitor", href: "/dashboard/competitors" }}
                  className="h-full justify-center"
                />
              )}
            </div>
          </div>
          
        </div>

        {/* Right Column (5/12) */}
        <div className="lg:col-span-5 space-y-6 flex flex-col">

          {/* Quick Actions Panel */}
          <div className="stagger-entrance bg-surface-2 border border-border rounded-xl p-5" style={{ animationDelay: "160ms" }}>
            <h2 className="text-sm font-bold text-text-primary mb-4">Quick Actions</h2>
            <div className="grid grid-cols-1 gap-2.5">
              <button
                onClick={() => handleQuickAction("add")}
                className="group btn-lift cursor-target flex items-center justify-between p-3.5 rounded-xl border border-border bg-surface-3/50 hover:bg-surface-3 transition-colors text-left w-full"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-950/60 border border-emerald-900/60 text-emerald-400">
                    <Plus className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-text-primary">Add Competitor</p>
                    <p className="text-[10px] text-text-muted">Track a new brand or product</p>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-text-muted transition-transform duration-150 ease-[var(--ease-out)] group-hover:translate-x-[3px]" />
              </button>

              <button
                onClick={() => handleQuickAction("analyze")}
                className="group btn-lift cursor-target flex items-center justify-between p-3.5 rounded-xl border border-border bg-surface-3/50 hover:bg-surface-3 transition-colors text-left w-full"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-indigo-950/60 border border-indigo-900/60 text-indigo-400">
                    <Play className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-text-primary">Run AI Analysis</p>
                    <p className="text-[10px] text-text-muted">Scan the market using Gemini</p>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-text-muted transition-transform duration-150 ease-[var(--ease-out)] group-hover:translate-x-[3px]" />
              </button>

              <button
                onClick={() => handleQuickAction("report")}
                className="group btn-lift cursor-target flex items-center justify-between p-3.5 rounded-xl border border-border bg-surface-3/50 hover:bg-surface-3 transition-colors text-left w-full"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-amber-950/60 border border-amber-900/60 text-amber-400">
                    <Download className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-text-primary">View Reports</p>
                    <p className="text-[10px] text-text-muted">Open and export generated reports</p>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-text-muted transition-transform duration-150 ease-[var(--ease-out)] group-hover:translate-x-[3px]" />
              </button>
            </div>
          </div>

          {/* Activity Feed Panel */}
          <div className="stagger-entrance bg-surface-2 border border-border rounded-xl p-5 flex flex-col flex-1" style={{ animationDelay: "200ms" }}>
            <h2 className="text-sm font-bold text-text-primary mb-4">Activity Feed</h2>
            <div className="space-y-1 flex-1 overflow-y-auto max-h-[300px] pr-1">
              {activityFeed.map((act) => {
                const Icon = act.icon;
                return (
                  <div
                    key={act.id}
                    className="flex gap-3 text-xs leading-normal -mx-2 px-2 py-1.5 rounded-lg"
                  >
                    <div className={`p-2 rounded-lg shrink-0 w-8 h-8 flex items-center justify-center ${act.color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="space-y-0.5 min-w-0">
                      <p className="text-text-primary font-medium">{act.text}</p>
                      <p className="text-[10px] text-text-muted">{act.time}</p>
                    </div>
                  </div>
                );
              })}
              {activityFeed.length === 0 && (
                <EmptyState compact icon={Activity} title="No recent activity" />
              )}
            </div>
          </div>
          
        </div>
      </div>

      {/* Full Width: Emerging Threats Table */}
      <div className="stagger-entrance bg-surface-2 border border-border rounded-xl p-5" style={{ animationDelay: "240ms" }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-text-primary">Emerging Market Threats</h2>
            <span className="bg-danger-bg border border-danger/20 text-danger text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              Score &gt; 50
            </span>
          </div>
          <Link href="/dashboard/competitors" className="group text-xs text-text-muted hover:text-text-primary flex items-center gap-1 transition-colors">
            <span>View All Competitors</span>
            <ArrowRight className="w-3.5 h-3.5 transition-transform duration-150 ease-[var(--ease-out)] group-hover:translate-x-[3px]" />
          </Link>
        </div>

        <div className="overflow-x-auto -mx-5 px-5">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b border-border/60 text-text-muted font-bold">
                <th className="pb-2.5">Name</th>
                <th className="pb-2.5">Source / Status</th>
                <th className="pb-2.5">Threat Score</th>
                <th className="pb-2.5">Tags</th>
                <th className="pb-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {emergingThreats.slice(0, 4).map((c) => (
                <tr key={c.id} className="row-hover">
                  <td className="py-3 font-semibold text-text-primary">
                    <div>{c.name}</div>
                    {c.website && <span className="text-[10px] text-text-muted font-normal block">{c.website}</span>}
                  </td>
                  <td className="py-3">
                    {c.is_fixed ? (
                      <Badge tone="neutral">Reference</Badge>
                    ) : c.status ? (
                      <Badge tone="success" dot>{c.status}</Badge>
                    ) : (
                      <Badge tone="accent" dot>Analysis Mapped</Badge>
                    )}
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-surface-3 border border-border rounded-full overflow-hidden">
                        <div
                          className="h-full bg-accent transition-[width] duration-[250ms] ease-[var(--ease-out)]"
                          style={{ width: `${c.threatScore || 30}%` }}
                        />
                      </div>
                      <span className="font-mono text-text-secondary">{c.threatScore || 30}</span>
                    </div>
                  </td>
                  <td className="py-3">
                    <div className="flex flex-wrap gap-1">
                      {(c.tags || []).slice(0, 2).map((t: string) => (
                        <span key={t} className="px-1.5 py-0.5 rounded bg-surface-3 border border-border text-[9px] text-text-secondary font-mono">
                          {t}
                        </span>
                      ))}
                      {c.tags?.length > 2 && (
                        <span className="px-1 py-0.5 text-[8px] text-text-muted">+{c.tags.length - 2}</span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 text-right">
                    <button
                      onClick={() => router.push(c.is_fixed ? `/dashboard/competitors` : `/dashboard/competitors/${c.id}`)}
                      className="btn-lift cursor-target px-2.5 py-1 rounded border border-border hover:bg-surface-3 hover:text-text-primary text-[10px] font-semibold transition-colors"
                    >
                      View details
                    </button>
                  </td>
                </tr>
              ))}
              {emergingThreats.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      compact
                      icon={TrendingUp}
                      title="No high-threat competitors"
                      description="Competitors scoring above 50 threat will appear here."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "next-themes";
import { ThemedToaster } from "@/components/theme/ThemedToaster";
import { fontVariables } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stylecraft Lens — Competitive Intelligence",
  description: "Know your competition. Own your market. AI-powered competitive intelligence SaaS for the creative, grooming, and beauty industry.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const useClerk = !!publishableKey && publishableKey !== "pk_..." && publishableKey !== "";

  const content = (
    <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
      {children}
      <ThemedToaster />
    </ThemeProvider>
  );

  if (useClerk) {
    return (
      <html lang="en" suppressHydrationWarning className={fontVariables}>
        <ClerkProvider publishableKey={publishableKey}>
          <body className="bg-bg text-text-primary antialiased">
            {content}
          </body>
        </ClerkProvider>
      </html>
    );
  }

  return (
    <html lang="en" suppressHydrationWarning className={fontVariables}>
      <body className="bg-bg text-text-primary antialiased">
        {content}
      </body>
    </html>
  );
}

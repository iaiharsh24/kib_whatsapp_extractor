"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getToken } from "@/lib/api";
import Shell from "@/components/Shell";

export default function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const path = pathname ?? "";
  const isLogin = path === "/login";
  const isSignup = path === "/signup" || path.startsWith("/signup/");
  const isInvite = path.startsWith("/invite/");
  const isPublicAuth = isLogin || isSignup || isInvite;

  useEffect(() => {
    const token = getToken();
    if (!isPublicAuth && !token) {
      router.replace("/login");
      return;
    }
    if ((isLogin || isSignup) && token) {
      router.replace("/");
      return;
    }
    setReady(true);
  }, [isPublicAuth, isLogin, isSignup, pathname, router]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-zinc-500">
        Loading...
      </div>
    );
  }

  if (isLogin || isSignup || isInvite) {
    return <>{children}</>;
  }

  return <Shell>{children}</Shell>;
}

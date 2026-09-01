"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getToken } from "@/lib/api";
import Shell from "@/components/Shell";

export default function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const isLogin = pathname === "/login";
  const isInvite = pathname.startsWith("/invite/");

  useEffect(() => {
    const token = getToken();
    if (!isLogin && !isInvite && !token) {
      router.replace("/login");
      return;
    }
    if (isLogin && token) {
      router.replace("/");
      return;
    }
    setReady(true);
  }, [isInvite, isLogin, pathname, router]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-zinc-500">
        Loading...
      </div>
    );
  }

  if (isLogin || isInvite) {
    return <>{children}</>;
  }

  return <Shell>{children}</Shell>;
}

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DatabasePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/control");
  }, [router]);
  return <div className="p-6 text-sm text-zinc-500">Redirecting to control center…</div>;
}

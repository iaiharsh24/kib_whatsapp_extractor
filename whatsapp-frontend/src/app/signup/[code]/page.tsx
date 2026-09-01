"use client";

import { useParams } from "next/navigation";
import { SignupForm } from "@/components/SignupForm";

export default function SignupWithCodePage() {
  const params = useParams<{ code: string }>();
  return <SignupForm initialCode={params?.code ?? ""} />;
}

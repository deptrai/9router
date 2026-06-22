import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getMachineId } from "@/shared/utils/machine";
import EndpointPageClient from "./endpoint/EndpointPageClient";

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  if (token) {
    const session = await getDashboardAuthSession(token);
    const role = session?.role ?? "admin";
    if (role === "admin") redirect("/dashboard/admin");
  }
  const machineId = await getMachineId();
  return <EndpointPageClient machineId={machineId} />;
}

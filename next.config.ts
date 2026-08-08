import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The outreach resume is read from disk at send time (lib/resume-file.ts), not imported,
   * so Next's output file tracing has no way to know it is needed and would leave it out of
   * the serverless bundle. It works locally and then every founder gets an email with no
   * attachment, which the agent card would report only after the fact.
   *
   * Keyed on `/*` because outreach sends from three routes: `/api/funding` (the unattended
   * morning cron) and the `/` and `/funding` server actions. One 152KB file, so scoping it
   * more tightly buys nothing and risks missing a route later.
   */
  outputFileTracingIncludes: {
    "/*": ["./profile/Shivansh_Chaudhary_Resume.pdf"],
  },
};

export default nextConfig;

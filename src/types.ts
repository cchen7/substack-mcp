export type LoginStatus = {
  loggedIn: boolean;
  url: string;
  user?: {
    id?: string | number;
    name?: string;
    handle?: string;
    email?: string;
  };
  evidence: string[];
};

export type Publication = {
  id?: string | number;
  name: string;
  url: string;
  subdomain?: string;
  customDomain?: string;
  description?: string;
  rawSource?: string;
};

export type PostSummary = {
  id?: string | number;
  title: string;
  subtitle?: string;
  url: string;
  canonicalUrl?: string;
  publicationUrl: string;
  publishedAt?: string;
  author?: string;
  audience?: string;
  isPaid?: boolean;
};

export type PostContent = {
  title?: string;
  subtitle?: string;
  url: string;
  canonicalUrl?: string;
  markdown: string;
  html?: string;
  accessState: "full" | "preview_only" | "access_denied" | "unknown";
  evidence: string[];
};

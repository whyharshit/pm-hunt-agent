export type Job = {
  id: string;
  source: 'remoteok' | 'hn' | 'wellfound' | 'yc';
  title: string;
  company: string;
  location: string;
  url: string;
  applyUrl?: string;
  postedAt: Date;
  tags: string[];
  description?: string;
  salary?: string;
};

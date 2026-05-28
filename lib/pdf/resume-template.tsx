import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

type Education = {
  degree: string;
  institution: string;
  graduationYear?: number;
  score?: string;
};

type ResumeShape = {
  name: string;
  email: string;
  phone?: string;
  location?: string;
  links?: Record<string, string>;
  education: Education[];
  experience: Array<{
    role: string;
    company: string;
    location?: string;
    dates?: string;
    bullets: string[];
  }>;
  positionsOfResponsibility?: Array<{
    role: string;
    organization: string;
    dates?: string;
    bullets: string[];
  }>;
  competitions?: Array<{
    title: string;
    organization: string;
    date?: string;
    bullets: string[];
  }>;
  projects?: Array<{
    name: string;
    type?: string;
    dates?: string;
    bullets: string[];
  }>;
  skills?: {
    languagesAndSoftware?: string[];
    coursework?: Record<string, string[]>;
    automationAndGtm?: string[];
  };
  awards?: string[];
  extraCurricular?: Array<{ category: string; detail: string }>;
};

type TailoredOverride = {
  summary: string;
  experience: Array<{ role: string; company: string; bullets: string[] }>;
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 28,
    paddingBottom: 28,
    paddingHorizontal: 36,
    fontSize: 9,
    fontFamily: 'Helvetica',
    color: '#1a1a1a',
    lineHeight: 1.3,
  },
  name: { fontSize: 18, fontFamily: 'Helvetica-Bold', textAlign: 'center' },
  contact: { fontSize: 9, textAlign: 'center', marginTop: 3, color: '#444' },
  sectionTitle: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    marginTop: 8,
    marginBottom: 3,
    paddingBottom: 1,
    borderBottomWidth: 0.7,
    borderBottomColor: '#1a1a1a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  entryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 3,
  },
  entryTitle: { fontFamily: 'Helvetica-Bold', fontSize: 9.5 },
  entryRight: { fontSize: 9, color: '#444' },
  entrySub: { fontSize: 9, fontStyle: 'italic', color: '#333', marginTop: 1 },
  bulletRow: { flexDirection: 'row', marginTop: 1.5, paddingLeft: 4 },
  bulletDot: { width: 8 },
  bulletText: { flex: 1, fontSize: 9 },
  summary: { fontSize: 9.5, marginTop: 2, textAlign: 'justify' },
  skillsRow: { flexDirection: 'row', marginTop: 2 },
  skillsLabel: { fontFamily: 'Helvetica-Bold', fontSize: 9 },
  skillsValue: { flex: 1, fontSize: 9 },
  awardRow: { flexDirection: 'row', marginTop: 1.5, paddingLeft: 4 },
  awardText: { flex: 1, fontSize: 9 },
  educationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
});

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletDot}>•</Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

function flattenSkills(skills: ResumeShape['skills']): string[] {
  if (!skills) return [];
  const out: string[] = [];
  if (skills.languagesAndSoftware?.length) {
    out.push(`Languages & Software: ${skills.languagesAndSoftware.join(', ')}`);
  }
  if (skills.coursework) {
    const cw = skills.coursework;
    const parts: string[] = [];
    if (cw.stanford?.length) parts.push(`Stanford (${cw.stanford.join(', ')})`);
    if (cw.mit?.length) parts.push(`MIT (${cw.mit.join(', ')})`);
    if (cw.iitGuwahati?.length) parts.push(`IIT Guwahati (${cw.iitGuwahati.join(', ')})`);
    if (cw.coursera?.length) parts.push(`Coursera (${cw.coursera.join(', ')})`);
    if (cw.selfStudy?.length) parts.push(`Self-study (${cw.selfStudy.join(', ')})`);
    if (parts.length) out.push(`Coursework: ${parts.join('; ')}`);
  }
  if (skills.automationAndGtm?.length) {
    out.push(`Automation & GTM: ${skills.automationAndGtm.join(', ')}`);
  }
  return out;
}

export function ResumeDocument({
  resume,
  tailored,
}: {
  resume: ResumeShape;
  tailored?: TailoredOverride;
}) {
  const summary = tailored?.summary ?? '';

  const experience = resume.experience.map((e, i) => {
    const overrideBullets = tailored?.experience[i]?.bullets;
    return {
      ...e,
      bullets: overrideBullets ?? e.bullets,
    };
  });

  const contactParts = [
    resume.email,
    resume.phone,
    resume.location,
    ...Object.values(resume.links ?? {}),
  ].filter(Boolean) as string[];

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.name}>{resume.name}</Text>
        <Text style={styles.contact}>{contactParts.join(' · ')}</Text>

        {summary && (
          <>
            <Text style={styles.sectionTitle}>Summary</Text>
            <Text style={styles.summary}>{summary}</Text>
          </>
        )}

        <Text style={styles.sectionTitle}>Experience</Text>
        {experience.map((e, i) => (
          <View key={`${e.company}-${i}`}>
            <View style={styles.entryRow}>
              <Text style={styles.entryTitle}>
                {e.role} · {e.company}
              </Text>
              <Text style={styles.entryRight}>{e.dates ?? ''}</Text>
            </View>
            {e.location && <Text style={styles.entrySub}>{e.location}</Text>}
            {e.bullets.map((b, j) => (
              <Bullet key={j}>{b}</Bullet>
            ))}
          </View>
        ))}

        {resume.positionsOfResponsibility && resume.positionsOfResponsibility.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Positions of Responsibility</Text>
            {resume.positionsOfResponsibility.map((p, i) => (
              <View key={i}>
                <View style={styles.entryRow}>
                  <Text style={styles.entryTitle}>
                    {p.role} · {p.organization}
                  </Text>
                  <Text style={styles.entryRight}>{p.dates ?? ''}</Text>
                </View>
                {p.bullets.map((b, j) => (
                  <Bullet key={j}>{b}</Bullet>
                ))}
              </View>
            ))}
          </>
        )}

        {resume.projects && resume.projects.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Projects</Text>
            {resume.projects.map((p, i) => (
              <View key={i}>
                <View style={styles.entryRow}>
                  <Text style={styles.entryTitle}>
                    {p.name}
                    {p.type ? ` · ${p.type}` : ''}
                  </Text>
                  <Text style={styles.entryRight}>{p.dates ?? ''}</Text>
                </View>
                {p.bullets.map((b, j) => (
                  <Bullet key={j}>{b}</Bullet>
                ))}
              </View>
            ))}
          </>
        )}

        {resume.competitions && resume.competitions.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Competitions</Text>
            {resume.competitions.map((c, i) => (
              <View key={i}>
                <View style={styles.entryRow}>
                  <Text style={styles.entryTitle}>
                    {c.title} · {c.organization}
                  </Text>
                  <Text style={styles.entryRight}>{c.date ?? ''}</Text>
                </View>
                {c.bullets.map((b, j) => (
                  <Bullet key={j}>{b}</Bullet>
                ))}
              </View>
            ))}
          </>
        )}

        <Text style={styles.sectionTitle}>Education</Text>
        {resume.education.map((ed, i) => (
          <View key={i} style={styles.educationRow}>
            <Text style={{ fontSize: 9 }}>
              <Text style={{ fontFamily: 'Helvetica-Bold' }}>{ed.degree}</Text>
              {' · '}
              {ed.institution}
              {ed.score ? `  (${ed.score})` : ''}
            </Text>
            <Text style={styles.entryRight}>{ed.graduationYear ?? ''}</Text>
          </View>
        ))}

        {flattenSkills(resume.skills).length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Skills</Text>
            {flattenSkills(resume.skills).map((line, i) => (
              <Text key={i} style={styles.summary}>
                {line}
              </Text>
            ))}
          </>
        )}

        {resume.awards && resume.awards.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Awards</Text>
            {resume.awards.map((a, i) => (
              <View key={i} style={styles.awardRow}>
                <Text style={styles.bulletDot}>•</Text>
                <Text style={styles.awardText}>{a}</Text>
              </View>
            ))}
          </>
        )}

        {resume.extraCurricular && resume.extraCurricular.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Extra-curricular</Text>
            {resume.extraCurricular.map((x, i) => (
              <View key={i} style={styles.awardRow}>
                <Text style={styles.bulletDot}>•</Text>
                <Text style={styles.awardText}>
                  <Text style={{ fontFamily: 'Helvetica-Bold' }}>{x.category}: </Text>
                  {x.detail}
                </Text>
              </View>
            ))}
          </>
        )}
      </Page>
    </Document>
  );
}

export type { ResumeShape, TailoredOverride };

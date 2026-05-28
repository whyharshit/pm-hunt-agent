import { renderToBuffer } from '@react-pdf/renderer';
import resumeData from '@/profile/resume.json';
import { ResumeDocument, type ResumeShape, type TailoredOverride } from './resume-template';

const RESUME = resumeData as ResumeShape;

export async function renderResumePdf(tailored?: TailoredOverride): Promise<Buffer> {
  return renderToBuffer(<ResumeDocument resume={RESUME} tailored={tailored} />);
}

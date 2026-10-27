import type { ReactNode } from 'react';
import { PageHero, Section } from '@/components/ui';
import type { LegalDoc } from '@/lib/content';

/** Shared layout for the legal pages: a short hero with a one-line intro, plain sections and the date last updated at the end. */
export default function LegalPage({ label, line1, line2, doc }: { label: string; line1: ReactNode; line2: ReactNode; doc: LegalDoc }) {
  return (
    <>
      <PageHero label={label} line1={line1} line2={line2} lead={doc.intro} />
      <Section label={label} size="sm">
        <div className="narrow">
          <div className="prose">
            {doc.sections.map((s) => (
              <section key={s.heading}>
                <h2>{s.heading}</h2>
                {s.body.map((b, i) =>
                  typeof b === 'string' ? (
                    <p key={i}>{b}</p>
                  ) : Array.isArray(b) ? (
                    <ul key={i}>
                      {b.map((li) => (
                        <li key={li}>{li}</li>
                      ))}
                    </ul>
                  ) : (
                    <table key={i}>
                      <thead>
                        <tr>
                          {b.head.map((h) => (
                            <th key={h} scope="col">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {b.rows.map(([detail, why]) => (
                          <tr key={detail}>
                            <td>{detail}</td>
                            <td>{why}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ),
                )}
              </section>
            ))}
            <p className="prose__updated">Last updated {doc.updated}</p>
          </div>
        </div>
      </Section>
    </>
  );
}

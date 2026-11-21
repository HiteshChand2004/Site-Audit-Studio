import CtaBand from '@/components/CtaBand';
import PostCard from '@/components/PostCard';
import { PageHero, Section } from '@/components/ui';
import { getPosts } from '@/lib/cms';
import { pageMeta } from '@/lib/meta';
import '@/app/media.css';

export const revalidate = 300;

export const metadata = pageMeta('/media', 'Media', 'Blog posts and news from the Remastly team: website audits, rebuilds, performance and SEO.');

export default async function Media() {
  const posts = await getPosts();

  return (
    <>
      <PageHero label="Media" line1="Notes from" line2="the team." ghost="Media" lead="Blog posts on website audits, rebuilds, speed and SEO." />

      <Section label="Blog posts" size="sm">
        {posts.length ? (
          <div className="post-grid">
            {posts.map((p, i) => (
              <PostCard key={p.id || p.slug} post={p} delay={(i % 3) * 80} />
            ))}
          </div>
        ) : (
          <p className="post-empty lead">No posts yet. Check back soon.</p>
        )}
      </Section>

      <CtaBand />
    </>
  );
}

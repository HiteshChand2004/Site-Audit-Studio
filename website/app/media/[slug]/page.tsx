import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import CtaBand from '@/components/CtaBand';
import { Eyebrow, JsonLd } from '@/components/ui';
import { formatDate, getPost, getPosts } from '@/lib/cms';
import { pageMeta } from '@/lib/meta';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import '@/app/media.css';

export const revalidate = 300;

type Props = { params: Promise<{ slug: string }> };

// Posts known at build time are prerendered; newer ones render on first visit and are then cached.
export async function generateStaticParams() {
  const posts = await getPosts();
  return posts.filter((p) => !p.externalUrl).map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return { title: 'Post not found', robots: { index: false } };
  const meta = pageMeta(`/media/${post.slug}`, post.title, post.excerpt || `${post.title}, on the ${SITE_NAME} blog.`);
  if (post.img) {
    meta.openGraph = { ...meta.openGraph, type: 'article', images: [{ url: post.img.url, alt: post.title }] };
    meta.twitter = { ...meta.twitter, images: [post.img.url] };
  }
  return meta;
}

export default async function MediaPost({ params }: Props) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();
  if (post.externalUrl) redirect(post.externalUrl);

  const date = formatDate(post.date);

  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: post.title,
          description: post.excerpt || undefined,
          datePublished: post.date,
          dateModified: post.updatedAt,
          author: post.author ? { '@type': 'Person', name: post.author } : undefined,
          image: post.img?.url,
          mainEntityOfPage: `${SITE_URL}/media/${post.slug}`,
          publisher: { '@type': 'Organization', name: SITE_NAME },
        }}
      />

      <article className="post">
        <header className="post__head container">
          <Link href="/media" className="post__back">
            <ArrowLeft size={16} aria-hidden="true" />
            All posts
          </Link>
          <Eyebrow>{post.type || 'Blog'}</Eyebrow>
          <h1 className="post__title">{post.title}</h1>
          {post.excerpt && <p className="lead post__lead">{post.excerpt}</p>}
          <p className="post-meta">
            {post.author && <span>{post.author}</span>}
            {post.author && date && <span aria-hidden="true">·</span>}
            {date && <time dateTime={post.date}>{date}</time>}
          </p>
        </header>

        {post.img && (
          <div className="container post__hero">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed CMS URLs change, so they skip the image optimizer */}
            <img src={post.img.url} alt="" style={{ objectPosition: post.img.objectPosition }} />
          </div>
        )}

        {/* Rich text written by the team in Botza CMS. */}
        <div className="container">
          <div className="prose" dangerouslySetInnerHTML={{ __html: post.content }} />
        </div>
      </article>

      <CtaBand />
    </>
  );
}

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { formatDate, type Post } from '@/lib/cms';

/** One post in the Media grid. Posts that live on another site open there in a new tab. */
export default function PostCard({ post, delay }: { post: Post; delay?: number }) {
  const date = formatDate(post.date);
  const inner = (
    <>
      <div className="post-card__media">
        {post.img ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed CMS URLs change, so they skip the image optimizer
          <img src={post.img.url} alt="" loading="lazy" decoding="async" style={{ objectPosition: post.img.objectPosition }} />
        ) : (
          <span className="post-card__placeholder" aria-hidden="true">
            {post.title.charAt(0)}
          </span>
        )}
      </div>
      <div className="post-card__body">
        <p className="post-meta">
          {post.type && <span className="badge badge--accent">{post.type}</span>}
          {date && <time dateTime={post.date}>{date}</time>}
        </p>
        <h2 className="post-card__title">
          {post.title}
          {post.externalUrl && <ArrowUpRight size={18} aria-label="(opens another site)" />}
        </h2>
        {post.excerpt && <p className="post-card__excerpt">{post.excerpt}</p>}
        {post.author && <p className="post-card__author">{post.author}</p>}
      </div>
    </>
  );

  return (
    <article className="card card--hover post-card" data-reveal style={delay ? { ['--d' as string]: `${delay}ms` } : undefined}>
      {post.externalUrl ? (
        <a href={post.externalUrl} target="_blank" rel="noopener noreferrer" className="post-card__link">
          {inner}
        </a>
      ) : (
        <Link href={`/media/${post.slug}`} className="post-card__link">
          {inner}
        </Link>
      )}
    </article>
  );
}

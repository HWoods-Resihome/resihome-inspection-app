/**
 * /services/[id]/photos — full-screen photo gallery for a Service Work Order,
 * powered by the shared PhotoLightbox (read-only): Before / After / Pet groups you
 * toggle between and swipe through. This is the target the completion PDF's photo
 * links open (deep-linked via ?g=<group>&i=<index>), and a standalone gallery.
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { fetchServiceWorkOrder } from '@/lib/hubspot';
import { PhotoLightbox } from '@/components/PhotoLightbox';

const splitUrls = (v: any): string[] => String(v || '').split(/[\n,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s.split('#')[0]));

interface GalleryProps {
  id: string;
  groups: { id: string; name: string }[];
  photosByGroup: Record<string, string[]>;
  address: string;
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  const id = String(ctx.params?.id || '');
  if (!/^\d+$/.test(id)) return { redirect: { destination: `/services/${id}`, permanent: false } };
  const rec = await fetchServiceWorkOrder(id).catch(() => null);
  if (!rec) return { redirect: { destination: '/services', permanent: false } };
  const p = rec.props;
  const groups: { id: string; name: string }[] = [];
  const photosByGroup: Record<string, string[]> = {};
  const add = (gid: string, name: string, urls: string[]) => { if (urls.length) { groups.push({ id: gid, name }); photosByGroup[gid] = urls; } };
  add('before', 'Before', splitUrls(p.before_photo_urls));
  add('after', 'After', splitUrls(p.after_photo_urls));
  add('petBefore', 'Pet — Before', splitUrls(p.pet_before_photo_urls));
  add('petAfter', 'Pet — After', splitUrls(p.pet_after_photo_urls));
  if (!groups.length) return { redirect: { destination: `/services/${id}`, permanent: false } };
  return { props: { id, groups, photosByGroup, address: p.address_snapshot || p.service_name || '' } as GalleryProps };
};

export default function ServicePhotos({ id, groups, photosByGroup }: GalleryProps) {
  const router = useRouter();
  const qg = typeof router.query.g === 'string' ? router.query.g : '';
  const qi = Number(router.query.i);
  const initialGroupId = groups.some((g) => g.id === qg) ? qg : groups[0].id;
  const initialIndex = Number.isFinite(qi) && qi >= 0 ? qi : 0;
  const [open, setOpen] = useState(true);
  const back = () => router.replace(`/services/${id}`);
  return (
    <div className="min-h-screen bg-black">
      {open && (
        <PhotoLightbox
          groups={groups}
          photosByGroup={photosByGroup}
          initialGroupId={initialGroupId}
          initialIndex={initialIndex}
          readOnly
          onClose={() => { setOpen(false); back(); }}
          onDelete={() => { /* read-only */ }}
          onReplace={() => { /* read-only */ }}
        />
      )}
    </div>
  );
}

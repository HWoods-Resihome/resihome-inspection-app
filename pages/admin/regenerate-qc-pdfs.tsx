/**
 * /admin/regenerate-qc-pdfs → folded into the combined /admin/regenerate-pdfs
 * tool (pick which types to regenerate). Kept as a redirect so old links work.
 */
import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: { destination: '/admin/regenerate-pdfs', permanent: false },
});

export default function RedirectToCombined() { return null; }

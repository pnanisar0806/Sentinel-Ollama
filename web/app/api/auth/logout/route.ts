import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';
import { setCookie } from '@/lib/auth-http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  setCookie(res, request, SESSION_COOKIE, '', 0);
  return res;
}

export function GET(request: Request) {
  return Response.json({ instance: 'local', session: new URL(request.url).searchParams.get('session'), journal: [] })
}

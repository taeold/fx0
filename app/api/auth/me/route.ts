import { LOCAL_USER } from '../../../../lib/local-user'

export function GET() {
  return Response.json({ user: LOCAL_USER })
}

import { redirect } from 'next/navigation'

// One local user is always signed in.
export default function LoginPage() {
  redirect('/')
}

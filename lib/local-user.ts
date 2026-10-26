import type { AccountUser } from '../components/account-menu'

// This branch is single-user: one fixed user stands in for fx0 main's accounts and sign-in
// (lib/accounts.ts, lib/auth.ts and the auth routes).
export const LOCAL_USER: AccountUser = { id: 'local', name: 'You', email: null, picture: null }

'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'

import { createClient } from '@/lib/supabase/server'

const credentialsSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
  redirectTo: z.string().optional(),
})

export interface SignInState {
  error?: string
}

/** Only allow relative in-app paths, so `redirectTo` cannot become an open redirect. */
function safeRedirectTarget(value: string | undefined): string {
  if (!value) return '/dashboard'
  if (!value.startsWith('/') || value.startsWith('//')) return '/dashboard'
  return value
}

export async function signIn(_prevState: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    redirectTo: formData.get('redirectTo') ?? undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid credentials.' }
  }

  let supabase
  try {
    supabase = await createClient()
  } catch (error) {
    // Missing/invalid environment configuration. Log internally, stay vague publicly.
    console.error('[login] Supabase client could not be created:', error)
    return { error: 'Sign-in is unavailable. Contact an administrator.' }
  }

  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  })

  if (error) {
    console.error('[login] Sign-in failed:', error.message)
    // Deliberately generic: do not reveal whether the account exists.
    return { error: 'Invalid email or password.' }
  }

  redirect(safeRedirectTarget(parsed.data.redirectTo))
}

export async function signOut() {
  try {
    const supabase = await createClient()
    await supabase.auth.signOut()
  } catch (error) {
    console.error('[logout] Sign-out failed:', error)
  }
  redirect('/login')
}

// "Do not show this again" for the welcome screen. localStorage can be missing or throw (private
// windows, blocked site data): then the welcome simply opens every time.
const HIDE_WELCOME_KEY = 'bytethemoon.hideWelcome'

export function welcomeHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_WELCOME_KEY) === '1'
  } catch {
    return false
  }
}

export function setWelcomeHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(HIDE_WELCOME_KEY, '1')
    else localStorage.removeItem(HIDE_WELCOME_KEY)
  } catch {
    // storage blocked: the choice just isn't remembered
  }
}

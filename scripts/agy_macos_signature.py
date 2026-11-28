"""Apple code-signing requirement for Google's Antigravity CLI."""


def verify_google_cli_command(binary):
    requirement = (
        '=identifier "cli" and anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV" '
        'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
    )
    return ['/usr/bin/codesign', '--verify', '--strict', '--all-architectures', '-R', requirement, str(binary)]

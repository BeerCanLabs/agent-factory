# Backlog

## DRAFT Framework Onboarding
*   **Feature:** Add a step to the local AI onboarding flow in `AGENTS.md` to offer the user the ability to seamlessly adopt the DRAFT framework.
*   **Workflow:**
    1.  During the Factory deployment interview, the local AI asks: "Do you also want to adopt the DRAFT framework by spinning up a Draftsman agent?"
    2.  If yes, the local AI uses the user's local credentials (`gh repo create`) to bootstrap the `[org]-drafting-table` repository.
    3.  The local AI vendors the upstream DRAFT framework (`github.com/getdraft/draftsman`) into this new repo.
    4.  The local AI automatically registers the Draftsman 1st-party Cartridge into the newly deployed Factory, pointing it to the newly created repo.
*   **Why deferred?** Needs further design and testing to ensure the local AI execution of GitHub CLI commands is robust and doesn't complicate the initial Factory deployment interview.

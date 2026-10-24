# The shared agent runtime (DESIGN_AUTHORITY.md §6.18 RT1). One image runs every agent created from a configuration;
# the factory pins the version and an agent's soul, memory settings and adopted skills come from its configuration at each
# wake. An agent that adopts skills gets the factory's skills layer at /opt/factory/skills (SK4).
#   docker build -f runtimes/agent-runtime/Dockerfile -t factory-agent-runtime runtimes/agent-runtime
FROM python:3.12-slim
WORKDIR /app
COPY runtime ./runtime
COPY memory ./memory
ENV MEMORY_DIR=/tmp/mind SKILLS_DIR=/opt/factory/skills PYTHONUNBUFFERED=1
USER nobody
ENTRYPOINT ["python3", "-m", "runtime"]

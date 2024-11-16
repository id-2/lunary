import { useCallback, useMemo, useState } from "react";

import { BubbleMessage } from "@/components/SmartViewer/Message";

import { useProjectSWR, useRun, useUser } from "@/utils/dataHooks";
import errorHandler from "@/utils/errors";
import { formatDateTime } from "@/utils/format";
import {
  ActionIcon,
  Card,
  Center,
  Group,
  Loader,
  Menu,
  Pagination,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconDots, IconNeedleThread, IconTrash } from "@tabler/icons-react";
import Router, { useRouter } from "next/router";
import { parseAsString, useQueryState } from "nuqs";
import { hasAccess } from "shared";
import { mutate } from "swr";
import AppUserAvatar from "./AppUserAvatar";
import Feedbacks from "./Feedbacks";

const OUTPUT_ROLES = ["assistant", "ai", "system", "tool"];
const INPUT_ROLES = ["user"];

function parseMessageFromRun(run) {
  function extractMessages(msg, role, siblingRunId) {
    if (!msg) return [];

    if (Array.isArray(msg)) {
      return msg
        .map((item) => extractMessages(item, role, siblingRunId))
        .flat()
        .filter((msg) => msg.content !== undefined);
    }

    return {
      role: msg.role || role,
      content: typeof msg === "string" ? msg : msg.content,
      timestamp: new Date(
        INPUT_ROLES.includes(role) ? run.createdAt : run.endedAt,
      ),
      id: run.id,
      feedback: run.feedback,
      enrichments: msg.enrichments,

      ...(siblingRunId && { siblingRunId }),
      ...(OUTPUT_ROLES.includes(role) && {
        took:
          new Date(run.endedAt).getTime() - new Date(run.createdAt).getTime(),
      }),
    };
  }

  return [
    extractMessages(run.input, "user", run.siblingRunId),
    extractMessages(run.output, "assistant", run.siblingRunId),
  ];
}

// Renders a list of run (or just one)
// As a chat

function Message({
  msg,
  user,
  siblings,
  selectedIndex,
  handleRetrySelect,
  run,
  mutateLogs,
}) {
  const router = useRouter();
  const runId = router?.query?.selected;
  const { updateFeedback } = useRun(msg.id);
  const { data: relatedRuns } = useProjectSWR(
    runId && `/runs/${runId}/related`,
  );

  return (
    <>
      <BubbleMessage
        user={user}
        role={msg.role}
        content={msg.content}
        enrichments={msg.enrichments}
        extra={
          <>
            {/* {!!msg.took && (
              <Text c="dimmed" size="xs">
                {msg.took}ms
              </Text>
            )} */}

            {msg.role !== "user" && (
              <Feedbacks
                feedback={run.feedback}
                updateFeedback={async (feedback) => {
                  try {
                    const newRelatedRuns = [...relatedRuns];
                    await updateFeedback(feedback);

                    newRelatedRuns.find(({ id }, i) => {
                      if (id === msg.id) {
                        newRelatedRuns[i].feedback = feedback;
                      }
                    });

                    await mutate(`/runs/${runId}/related`, () => relatedRuns, {
                      revalidate: false,
                    });
                    await mutateLogs();
                  } catch (error) {
                    console.error(error);
                  }
                }}
              />
            )}
          </>
        }
      />

      {msg.role === "user" && siblings?.length > 1 && (
        <Pagination
          gap={1}
          mx="auto"
          mb="lg"
          mt={-6}
          size="xs"
          value={selectedIndex + 1}
          total={siblings.length}
          onChange={(page) => handleRetrySelect(run.id, page - 1)}
        />
      )}
    </>
  );
}

function RunsChat({ runs, mutateLogs }) {
  const [selectedRetries, setSelectedRetries] = useState({});

  // Each chat run has input = [user message], output = [bot message]
  const messages = useMemo(
    () =>
      runs
        ?.map(parseMessageFromRun)
        .flat(2)
        .sort((a, b) => a.timestamp - b.timestamp),
    [runs],
  );

  const getSiblingsOf = useCallback(
    (run) => {
      return runs?.filter((m) => [m.siblingRunId, m.id].includes(run.id));
    },
    [runs],
  );

  const handleRetrySelect = (messageId, retryIndex) => {
    setSelectedRetries((prevRetries) => ({
      ...prevRetries,
      [messageId]: retryIndex,
    }));
  };

  return (
    <Stack gap={0}>
      {runs
        ?.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .filter((run) => !run.siblingRunId) // Use the main tree as reference
        .map((run, i) => {
          const siblings = getSiblingsOf(run);
          const selectedIndex = selectedRetries[run.id] || 0;
          const picked = siblings[selectedIndex];

          if (run.type === "custom-event") {
            return (
              <Center key={i} c="dimmed" my="lg">
                <Text>{run.name}</Text>
              </Center>
            );
          }

          return messages
            .filter((m) => m.id === picked.id)
            .map((msg, i) => (
              <Message
                key={i}
                msg={msg}
                user={run.user}
                siblings={siblings}
                selectedIndex={selectedIndex}
                handleRetrySelect={handleRetrySelect}
                run={run}
                mutateLogs={mutateLogs}
              />
            ));
        })}
    </Stack>
  );
}

export function ChatReplay({ run, mutateLogs, deleteRun }) {
  const [_, setSelectedRunId] = useQueryState<string | undefined>(
    "selected",
    parseAsString,
  );

  const { data: runs, isLoading: loading } = useProjectSWR(
    run.id && `/runs?type=chat&parentRunId=${run.id}`,
  );

  const { data: user } = useProjectSWR(
    run.user?.id && `/external-users/${run.user?.id}`,
  );

  const sorted = runs?.data?.sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const { user: currentUser } = useUser();

  async function handleDeleteThread() {
    modals.openConfirmModal({
      title: "Delete Thread",
      children: (
        <Text size="sm">
          Are you sure you want to delete this Thread? This action will
          permanently remove the Thread and all its children. This cannot be
          undone.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        await errorHandler(deleteRun(run.id));
        setSelectedRunId(null);
        mutateLogs();
      },
    });
  }

  return (
    <Stack>
      <Group justify="right">
        <Menu>
          <Menu.Target>
            <ActionIcon variant="default">
              <IconDots size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconNeedleThread size={16} />}
              onClick={() => {
                Router.push(`/traces/${run.id}`);
              }}
            >
              View Trace
            </Menu.Item>
            {hasAccess(currentUser.role, "logs", "delete") && (
              <Menu.Item
                leftSection={<IconTrash size={16} color="red" />}
                onClick={handleDeleteThread}
              >
                <Text c="red">Delete Thread</Text>
              </Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      </Group>

      <Card withBorder radius="md">
        <Stack gap="xs">
          {user && (
            <Group justify="space-between">
              <Text>User</Text>
              <Text>
                <AppUserAvatar size="sm" user={user} withName />
              </Text>
            </Group>
          )}
          <Group justify="space-between">
            <Text>First message</Text>
            <Text>{formatDateTime(run.createdAt)}</Text>
          </Group>
          {!!sorted?.length && (
            <Group justify="space-between">
              <Text>Last message</Text>
              <Text>{formatDateTime(sorted[sorted.length - 1].createdAt)}</Text>
            </Group>
          )}
        </Stack>
      </Card>

      <Title order={3}>Replay</Title>

      {loading && <Loader />}

      <RunsChat runs={sorted} mutateLogs={mutateLogs} />
    </Stack>
  );
}

export default RunsChat;

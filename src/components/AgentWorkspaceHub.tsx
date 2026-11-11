import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { approveBrowserWorkspace, BrowserWorkspaceState, getBrowserWorkspace, pauseBrowserWorkspace, sendBrowserTakeover, startBrowserWorkspace } from '../lib/chat';

const HUB_KEY = '@tdotbot/agent-hub/v1';
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

type WorkspaceStatus = 'ready' | 'running' | 'paused' | 'needs_you' | 'complete';
type Workspace = {
  id: string;
  name: string;
  url: string;
  goal: string;
  status: WorkspaceStatus;
  updatedAt: number;
  history: string[];
};

type LearnedSkill = {
  id: string;
  name: string;
  steps: string[];
  createdAt: number;
};

type Trigger = 'schedule' | 'slack' | 'teams' | 'git' | 'linear' | 'sentry' | 'pagerduty' | 'webhook';
type Routine = {
  id: string;
  name: string;
  instructions: string;
  trigger: Trigger;
  triggerValue: string;
  active: boolean;
  lastRun?: number;
  lastResult?: string;
};

type HubData = { workspaces: Workspace[]; skills: LearnedSkill[]; routines: Routine[] };
type HubSection = 'computer' | 'teach' | 'routines';

const emptyHub: HubData = { workspaces: [], skills: [], routines: [] };
const triggerLabels: Record<Trigger, string> = {
  schedule: 'Schedule', slack: 'Slack', teams: 'Teams', git: 'Git', linear: 'Linear',
  sentry: 'Sentry', pagerduty: 'PagerDuty', webhook: 'Webhook',
};

export function AgentWorkspaceHub({ onRunAgent }: { onRunAgent: (prompt: string) => void }) {
  const [data, setData] = useState<HubData>(emptyHub);
  const [hydrated, setHydrated] = useState(false);
  const [section, setSection] = useState<HubSection>('computer');
  const [workspaceName, setWorkspaceName] = useState('Research workspace');
  const [workspaceUrl, setWorkspaceUrl] = useState('https://www.google.com');
  const [workspaceGoal, setWorkspaceGoal] = useState('Research this task and return a concise result with links.');
  const [skillName, setSkillName] = useState('My demonstrated task');
  const [stepDraft, setStepDraft] = useState('');
  const [recordedSteps, setRecordedSteps] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [routineName, setRoutineName] = useState('Morning brief');
  const [routineInstructions, setRoutineInstructions] = useState('Find meaningful updates and message me only when something is new.');
  const [trigger, setTrigger] = useState<Trigger>('schedule');
  const [triggerValue, setTriggerValue] = useState('Every day at 8:00 AM');
  const [remoteStates, setRemoteStates] = useState<Record<string, BrowserWorkspaceState>>({});
  const [takeoverText, setTakeoverText] = useState('');
  const [screenWidth, setScreenWidth] = useState(1);

  useEffect(() => {
    AsyncStorage.getItem(HUB_KEY)
      .then((value) => value && setData(JSON.parse(value) as HubData))
      .catch(() => undefined)
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (hydrated) AsyncStorage.setItem(HUB_KEY, JSON.stringify(data)).catch(() => undefined);
  }, [data, hydrated]);

  useEffect(() => {
    const activeIds = Object.values(remoteStates)
      .filter((item) => item.status === 'running')
      .map((item) => item.id);
    if (!activeIds.length) return;
    const timer = setInterval(() => {
      activeIds.forEach((id) => getBrowserWorkspace(id)
        .then((state) => {
          setRemoteStates((current) => ({ ...current, [id]: state }));
          setData((current) => ({
            ...current,
            workspaces: current.workspaces.map((item) => item.id === id ? {
              ...item,
              status: state.status === 'needs_approval' ? 'needs_you' : state.status as WorkspaceStatus,
              updatedAt: Date.now(),
              history: state.log[0]?.message ? [state.log[0].message, ...item.history].slice(0, 12) : item.history,
            } : item),
          }));
        })
        .catch(() => undefined));
    }, 2500);
    return () => clearInterval(timer);
  }, [remoteStates]);

  const activeCount = useMemo(() => data.routines.filter((item) => item.active).length, [data.routines]);

  const createWorkspace = () => {
    const url = workspaceUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      Alert.alert('Enter a full web address', 'The address must start with http:// or https://');
      return;
    }
    const workspace: Workspace = {
      id: uid(), name: workspaceName.trim() || 'Browser task', url,
      goal: workspaceGoal.trim() || 'Complete the requested browser task.', status: 'ready', updatedAt: Date.now(),
      history: ['Workspace created and waiting to run.'],
    };
    setData((current) => ({ ...current, workspaces: [workspace, ...current.workspaces] }));
  };

  const updateWorkspace = (id: string, update: Partial<Workspace>, event?: string) => {
    setData((current) => ({
      ...current,
      workspaces: current.workspaces.map((item) => item.id === id ? {
        ...item, ...update, updatedAt: Date.now(), history: event ? [event, ...item.history].slice(0, 12) : item.history,
      } : item),
    }));
  };

  const runWorkspace = async (workspace: Workspace) => {
    updateWorkspace(workspace.id, { status: 'running' }, 'Starting the persistent Chromium worker.');
    try {
      const state = await startBrowserWorkspace(workspace.id, workspace.url, workspace.goal);
      setRemoteStates((current) => ({ ...current, [workspace.id]: state }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start the browser worker.';
      updateWorkspace(workspace.id, { status: 'paused' }, message);
      Alert.alert('Browser worker unavailable', message);
    }
  };

  const refreshWorkspace = async (workspace: Workspace) => {
    try {
      const state = await getBrowserWorkspace(workspace.id);
      setRemoteStates((current) => ({ ...current, [workspace.id]: state }));
      updateWorkspace(workspace.id, { status: state.status === 'needs_approval' ? 'needs_you' : state.status as WorkspaceStatus }, state.log[0]?.message);
    } catch (error) {
      Alert.alert('Remote workspace unavailable', error instanceof Error ? error.message : 'Start the workspace first.');
    }
  };

  const pauseRemote = async (workspace: Workspace) => {
    try {
      const state = await pauseBrowserWorkspace(workspace.id);
      setRemoteStates((current) => ({ ...current, [workspace.id]: state }));
      updateWorkspace(workspace.id, { status: 'paused' }, 'Remote browser paused.');
    } catch {
      updateWorkspace(workspace.id, { status: 'paused' }, 'Workspace paused locally.');
    }
  };

  const tapRemote = async (workspace: Workspace, locationX: number, locationY: number) => {
    const height = screenWidth * 9 / 16;
    const state = await sendBrowserTakeover(workspace.id, {
      type: 'tap', x: locationX / screenWidth * 1280, y: locationY / height * 720,
    });
    setRemoteStates((current) => ({ ...current, [workspace.id]: state }));
    if (recording) setRecordedSteps((steps) => [...steps, `Tap the browser at ${Math.round(locationX / screenWidth * 100)}% across and ${Math.round(locationY / height * 100)}% down.`]);
  };

  const typeRemote = async (workspace: Workspace) => {
    if (!takeoverText) return;
    const state = await sendBrowserTakeover(workspace.id, { type: 'type', text: takeoverText });
    setRemoteStates((current) => ({ ...current, [workspace.id]: state }));
    if (recording) setRecordedSteps((steps) => [...steps, `Type: ${takeoverText}`]);
    setTakeoverText('');
  };

  const addStep = () => {
    const step = stepDraft.trim();
    if (!step) return;
    setRecordedSteps((steps) => [...steps, step]);
    setStepDraft('');
  };

  const saveSkill = () => {
    if (!skillName.trim() || !recordedSteps.length) {
      Alert.alert('Add a name and at least one demonstrated step.');
      return;
    }
    const skill: LearnedSkill = { id: uid(), name: skillName.trim(), steps: recordedSteps, createdAt: Date.now() };
    setData((current) => ({ ...current, skills: [skill, ...current.skills] }));
    setRecordedSteps([]);
    setRecording(false);
  };

  const runSkill = (skill: LearnedSkill) => {
    onRunAgent(`Run my saved skill "${skill.name}". Follow these demonstrated steps:\n${skill.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\nStop and ask me to take over for authentication, CAPTCHA, purchases, sending, publishing, or deletion.`);
  };

  const saveRoutine = () => {
    if (!routineName.trim() || !routineInstructions.trim() || !triggerValue.trim()) {
      Alert.alert('Complete the routine name, instructions, and trigger.');
      return;
    }
    const routine: Routine = {
      id: uid(), name: routineName.trim(), instructions: routineInstructions.trim(), trigger,
      triggerValue: triggerValue.trim(), active: false,
    };
    setData((current) => ({ ...current, routines: [routine, ...current.routines] }));
  };

  const updateRoutine = (id: string, update: Partial<Routine>) => {
    setData((current) => ({ ...current, routines: current.routines.map((item) => item.id === id ? { ...item, ...update } : item) }));
  };

  const testRoutine = (routine: Routine) => {
    updateRoutine(routine.id, { lastRun: Date.now(), lastResult: 'Test handed to Tdotbot' });
    onRunAgent(`Test run the routine "${routine.name}" now. Instructions: ${routine.instructions}. Its normal trigger is ${triggerLabels[routine.trigger]}: ${routine.triggerValue}. Do not assume the trigger fired; this is a manual dry run. Report results and any required approval.`);
  };

  return (
    <View style={styles.root}>
      <View style={styles.summary}>
        <View><Text style={styles.kicker}>AGENT WORKSPACE</Text><Text style={styles.heading}>Make the work visible.</Text></View>
        <View style={styles.counter}><Text style={styles.counterNumber}>{activeCount}</Text><Text style={styles.counterLabel}>ACTIVE</Text></View>
      </View>
      <View style={styles.tabs}>
        {(['computer', 'teach', 'routines'] as HubSection[]).map((item) => (
          <Pressable key={item} onPress={() => setSection(item)} style={[styles.tab, section === item && styles.tabActive]}>
            <Text style={[styles.tabText, section === item && styles.tabTextActive]}>{item === 'computer' ? 'Computer' : item === 'teach' ? 'Teach' : 'Routines'}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {section === 'computer' && <>
          <Text style={styles.sectionTitle}>New browser workspace</Text>
          <TextInput value={workspaceName} onChangeText={setWorkspaceName} placeholder="Workspace name" placeholderTextColor="#667384" style={styles.input} />
          <TextInput value={workspaceUrl} onChangeText={setWorkspaceUrl} autoCapitalize="none" keyboardType="url" placeholder="https://..." placeholderTextColor="#667384" style={styles.input} />
          <TextInput value={workspaceGoal} onChangeText={setWorkspaceGoal} multiline placeholder="What should the agent accomplish?" placeholderTextColor="#667384" style={[styles.input, styles.multiline]} />
          <Pressable onPress={createWorkspace} style={styles.primary}><Text style={styles.primaryText}>Create workspace</Text></Pressable>
          {data.workspaces.map((workspace) => (
            <View key={workspace.id} style={styles.card}>
              <View style={styles.cardHeader}><View style={styles.flex}><Text style={styles.cardTitle}>{workspace.name}</Text><Text numberOfLines={1} style={styles.muted}>{workspace.url}</Text></View><Text style={styles.status}>{workspace.status.replace('_', ' ').toUpperCase()}</Text></View>
              <Text style={styles.body}>{workspace.goal}</Text>
              {remoteStates[workspace.id]?.screenshot ? <>
                <Text style={styles.screenEyebrow}>LIVE COMPUTER · TAP SCREEN TO TAKE OVER</Text>
                <Pressable
                  onLayout={(event) => setScreenWidth(event.nativeEvent.layout.width)}
                  onPress={(event) => tapRemote(workspace, event.nativeEvent.locationX, event.nativeEvent.locationY).catch((error) => Alert.alert('Remote tap failed', error.message))}
                >
                  <Image source={{ uri: remoteStates[workspace.id].screenshot }} resizeMode="contain" style={styles.screenImage} />
                </Pressable>
                <Text style={styles.remoteUrl} numberOfLines={1}>{remoteStates[workspace.id].title} · {remoteStates[workspace.id].url}</Text>
                <View style={styles.takeoverComposer}>
                  <TextInput value={takeoverText} onChangeText={setTakeoverText} placeholder="Type into the focused remote field" placeholderTextColor="#667384" style={[styles.input, styles.takeoverInput]} />
                  <Pressable onPress={() => typeRemote(workspace).catch((error) => Alert.alert('Remote typing failed', error.message))} style={styles.smallPrimary}><Text style={styles.smallPrimaryText}>Type</Text></Pressable>
                </View>
                {remoteStates[workspace.id].pendingAction && <View style={styles.approvalBox}>
                  <Text style={styles.approvalText}>Approval required: {remoteStates[workspace.id].pendingAction?.text}</Text>
                  <View style={styles.actions}>
                    <Pressable onPress={() => approveBrowserWorkspace(workspace.id, false).then((state) => setRemoteStates((current) => ({ ...current, [workspace.id]: state })))} style={styles.secondary}><Text style={styles.secondaryText}>Deny</Text></Pressable>
                    <Pressable onPress={() => approveBrowserWorkspace(workspace.id, true).then((state) => setRemoteStates((current) => ({ ...current, [workspace.id]: state })))} style={styles.smallPrimary}><Text style={styles.smallPrimaryText}>Approve once</Text></Pressable>
                  </View>
                </View>}
              </> : <View style={styles.screenPreview}><Text style={styles.screenEyebrow}>REMOTE COMPUTER</Text><Text style={styles.screenText}>{workspace.history[0]}</Text></View>}
              <View style={styles.actions}>
                <Pressable onPress={() => runWorkspace(workspace)} style={styles.smallPrimary}><Text style={styles.smallPrimaryText}>Run agent</Text></Pressable>
                <Pressable onPress={() => refreshWorkspace(workspace)} style={styles.secondary}><Text style={styles.secondaryText}>Refresh</Text></Pressable>
                <Pressable onPress={() => Linking.openURL(remoteStates[workspace.id]?.url || workspace.url)} style={styles.secondary}><Text style={styles.secondaryText}>Open locally</Text></Pressable>
                <Pressable onPress={() => pauseRemote(workspace)} style={styles.secondary}><Text style={styles.secondaryText}>Pause</Text></Pressable>
              </View>
            </View>
          ))}
          {!data.workspaces.length && <Text style={styles.empty}>No browser workspaces yet.</Text>}
        </>}

        {section === 'teach' && <>
          <Text style={styles.sectionTitle}>Teach by demonstration</Text>
          <Text style={styles.help}>Start recording, describe each action you demonstrate, and use Take over from a browser workspace when needed. Tdotbot saves the sequence as a reusable skill.</Text>
          <TextInput value={skillName} onChangeText={setSkillName} placeholder="Skill name" placeholderTextColor="#667384" style={styles.input} />
          <View style={styles.actions}>
            <Pressable onPress={() => setRecording((value) => !value)} style={[styles.recordButton, recording && styles.recording]}><Text style={styles.recordText}>{recording ? '● Recording' : '○ Start recording'}</Text></Pressable>
            {!!recordedSteps.length && <Pressable onPress={saveSkill} style={styles.smallPrimary}><Text style={styles.smallPrimaryText}>Save skill</Text></Pressable>}
          </View>
          {recording && <View style={styles.stepComposer}>
            <TextInput value={stepDraft} onChangeText={setStepDraft} multiline placeholder="Describe the action you just demonstrated" placeholderTextColor="#667384" style={[styles.input, styles.flex]} />
            <Pressable onPress={addStep} style={styles.addStep}><Text style={styles.addStepText}>＋</Text></Pressable>
          </View>}
          {recordedSteps.map((step, index) => <Text key={`${index}-${step}`} style={styles.step}>{index + 1}. {step}</Text>)}
          <Text style={styles.sectionTitle}>Learned skills</Text>
          {data.skills.map((skill) => <View key={skill.id} style={styles.card}><Text style={styles.cardTitle}>{skill.name}</Text><Text style={styles.muted}>{skill.steps.length} demonstrated steps</Text><Pressable onPress={() => runSkill(skill)} style={styles.smallPrimary}><Text style={styles.smallPrimaryText}>Run skill</Text></Pressable></View>)}
          {!data.skills.length && <Text style={styles.empty}>No learned skills yet.</Text>}
        </>}

        {section === 'routines' && <>
          <Text style={styles.sectionTitle}>New routine</Text>
          <TextInput value={routineName} onChangeText={setRoutineName} placeholder="Routine name" placeholderTextColor="#667384" style={styles.input} />
          <TextInput value={routineInstructions} onChangeText={setRoutineInstructions} multiline placeholder="Instructions" placeholderTextColor="#667384" style={[styles.input, styles.multiline]} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.triggerRow}>
            {(Object.keys(triggerLabels) as Trigger[]).map((item) => <Pressable key={item} onPress={() => setTrigger(item)} style={[styles.trigger, trigger === item && styles.triggerActive]}><Text style={[styles.triggerText, trigger === item && styles.triggerTextActive]}>{triggerLabels[item]}</Text></Pressable>)}
          </ScrollView>
          <TextInput value={triggerValue} onChangeText={setTriggerValue} placeholder="Every day at 8:00 AM or event details" placeholderTextColor="#667384" style={styles.input} />
          <Pressable onPress={saveRoutine} style={styles.primary}><Text style={styles.primaryText}>Save inactive routine</Text></Pressable>
          {data.routines.map((routine) => <View key={routine.id} style={styles.card}>
            <View style={styles.cardHeader}><View style={styles.flex}><Text style={styles.cardTitle}>{routine.name}</Text><Text style={styles.muted}>{triggerLabels[routine.trigger]} · {routine.triggerValue}</Text></View><Pressable onPress={() => updateRoutine(routine.id, { active: !routine.active })} style={[styles.toggle, routine.active && styles.toggleActive]}><Text style={styles.toggleText}>{routine.active ? 'ON' : 'OFF'}</Text></Pressable></View>
            <Text style={styles.body}>{routine.instructions}</Text>
            {!!routine.lastResult && <Text style={styles.runHistory}>Last run: {routine.lastResult}</Text>}
            <View style={styles.actions}><Pressable onPress={() => testRoutine(routine)} style={styles.smallPrimary}><Text style={styles.smallPrimaryText}>Test run</Text></Pressable><Pressable onPress={() => setData((current) => ({ ...current, routines: current.routines.filter((item) => item.id !== routine.id) }))} style={styles.secondary}><Text style={styles.secondaryText}>Delete</Text></Pressable></View>
          </View>)}
          {!data.routines.length && <Text style={styles.empty}>No routines yet.</Text>}
        </>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: '#090d13' },
  summary: { paddingHorizontal: 18, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#1b222d' },
  kicker: { color: '#8ef0cb', fontSize: 10, letterSpacing: 1.5, fontWeight: '800' },
  heading: { color: '#f4f6f9', fontSize: 22, fontWeight: '800', marginTop: 3 },
  counter: { marginLeft: 'auto', alignItems: 'center', backgroundColor: '#141c24', borderRadius: 14, minWidth: 58, padding: 8 },
  counterNumber: { color: '#8ef0cb', fontSize: 18, fontWeight: '900' }, counterLabel: { color: '#788597', fontSize: 8, fontWeight: '800' },
  tabs: { flexDirection: 'row', padding: 8, gap: 6, backgroundColor: '#0d131b' }, tab: { flex: 1, paddingVertical: 9, borderRadius: 11, alignItems: 'center' }, tabActive: { backgroundColor: '#1b2631' }, tabText: { color: '#788597', fontSize: 12, fontWeight: '700' }, tabTextActive: { color: '#8ef0cb' },
  scroll: { flex: 1 }, content: { padding: 16, paddingBottom: 40 }, sectionTitle: { color: '#f1f4f7', fontSize: 17, fontWeight: '800', marginTop: 8, marginBottom: 10 },
  help: { color: '#929cab', fontSize: 13, lineHeight: 19, marginBottom: 12 }, input: { color: '#f1f4f7', backgroundColor: '#141c25', borderWidth: 1, borderColor: '#283443', borderRadius: 13, paddingHorizontal: 13, paddingVertical: 11, marginBottom: 9, fontSize: 14 }, multiline: { minHeight: 72, textAlignVertical: 'top' },
  primary: { backgroundColor: '#8ef0cb', padding: 13, borderRadius: 13, alignItems: 'center', marginBottom: 14 }, primaryText: { color: '#07120e', fontWeight: '900' },
  card: { backgroundColor: '#111923', borderWidth: 1, borderColor: '#26313e', borderRadius: 16, padding: 14, marginBottom: 12, gap: 9 }, cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 }, flex: { flex: 1 }, cardTitle: { color: '#f0f3f6', fontSize: 15, fontWeight: '800' }, muted: { color: '#7f8b9b', fontSize: 11, marginTop: 3 }, status: { color: '#8ef0cb', fontSize: 9, fontWeight: '900', backgroundColor: '#182a27', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 }, body: { color: '#b9c2cd', fontSize: 13, lineHeight: 19 },
  screenPreview: { minHeight: 74, backgroundColor: '#070a0f', borderRadius: 11, borderWidth: 1, borderColor: '#252f3b', padding: 11, justifyContent: 'center' }, screenEyebrow: { color: '#8ef0cb', fontSize: 9, fontWeight: '900', letterSpacing: 1.2 }, screenText: { color: '#aab5c2', fontSize: 12, marginTop: 6 },
  screenImage: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#030507', borderRadius: 10, marginTop: 7 },
  remoteUrl: { color: '#778596', fontSize: 10 },
  takeoverComposer: { flexDirection: 'row', alignItems: 'center', gap: 8 }, takeoverInput: { flex: 1, marginBottom: 0 },
  approvalBox: { borderWidth: 1, borderColor: '#f2b35f', backgroundColor: '#2a2115', borderRadius: 11, padding: 10, gap: 9 }, approvalText: { color: '#f6d29e', fontSize: 12, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }, smallPrimary: { backgroundColor: '#8ef0cb', paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, alignSelf: 'flex-start' }, smallPrimaryText: { color: '#07120e', fontSize: 12, fontWeight: '900' }, secondary: { backgroundColor: '#202a35', paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 }, secondaryText: { color: '#c9d1da', fontSize: 12, fontWeight: '700' }, empty: { color: '#657183', textAlign: 'center', padding: 24 },
  recordButton: { borderWidth: 1, borderColor: '#6e7c8e', borderRadius: 11, paddingHorizontal: 13, paddingVertical: 10 }, recording: { borderColor: '#ff6b79', backgroundColor: '#2a171c' }, recordText: { color: '#f1f4f7', fontSize: 12, fontWeight: '800' }, stepComposer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }, addStep: { width: 42, height: 42, borderRadius: 12, backgroundColor: '#8ef0cb', alignItems: 'center', justifyContent: 'center' }, addStepText: { color: '#07120e', fontSize: 23, fontWeight: '900' }, step: { color: '#c4cdd7', backgroundColor: '#151e28', borderRadius: 10, padding: 10, marginTop: 7, fontSize: 12 },
  triggerRow: { gap: 7, paddingBottom: 10 }, trigger: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 12, backgroundColor: '#171f29', borderWidth: 1, borderColor: '#273341' }, triggerActive: { borderColor: '#8ef0cb', backgroundColor: '#173029' }, triggerText: { color: '#8996a6', fontSize: 11, fontWeight: '700' }, triggerTextActive: { color: '#8ef0cb' }, toggle: { backgroundColor: '#28313d', paddingHorizontal: 11, paddingVertical: 7, borderRadius: 12 }, toggleActive: { backgroundColor: '#1b493a' }, toggleText: { color: '#dce3ea', fontSize: 10, fontWeight: '900' }, runHistory: { color: '#8ef0cb', fontSize: 11 },
});

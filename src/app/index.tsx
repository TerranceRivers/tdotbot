import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Calendar from 'expo-calendar/legacy';
import * as Contacts from 'expo-contacts';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  Share,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AgentWorkspaceHub } from '../components/AgentWorkspaceHub';
import { ChatAttachment, ChatMessage, continueTool, streamChat } from '../lib/chat';

const starters = [
  'Create a reminder',
  'Plan a route',
  'Save a note',
  'Help me send a message',
];

const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const STORAGE_KEY = '@tdotbot/sessions/v2';
const NOTES_KEY = '@tdotbot/notes/v1';
const isFutureDate = (date: Date) => !Number.isNaN(date.getTime()) && date.getTime() > Date.now();

type AgentActivity = {
  id: string;
  agent?: string;
  label: string;
  status: 'running' | 'complete';
};

type Approval = {
  id: string;
  responseId: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'approved' | 'cancelled';
};

type ChatSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
  activities: AgentActivity[];
  approvals: Approval[];
  updatedAt: number;
};

export default function ChatScreen() {
  const [activeView, setActiveView] = useState<'chat' | 'agent'>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState(uid());
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  const abortRef = useRef<null | (() => void)>(null);
  const { height, width } = useWindowDimensions();
  const compact = height < 700 || width < 360;

  const canSend = useMemo(() => draft.trim().length > 0 && !busy, [draft, busy]);
  const visibleSessions = useMemo<ChatSession[]>(() => [{
    id: activeSessionId,
    title: messages.find((message) => message.role === 'user')?.text.slice(0, 36) || 'New conversation',
    messages,
    activities,
    approvals,
    updatedAt: 0,
  }, ...sessions.filter((session) => session.id !== activeSessionId)], [activeSessionId, messages, activities, approvals, sessions]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (!value) return;
        const stored = JSON.parse(value) as { sessions?: ChatSession[]; activeSessionId?: string };
        const loaded = stored.sessions ?? [];
        setSessions(loaded);
        const active = loaded.find((session) => session.id === stored.activeSessionId) ?? loaded[0];
        if (active) {
          setActiveSessionId(active.id);
          setMessages(active.messages);
          setActivities(active.activities);
          setApprovals(active.approvals);
        }
      })
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const storedMessages = messages.map((message) => ({
      ...message,
      attachments: message.attachments?.map((attachment) => ({ ...attachment, dataUrl: '' })),
    }));
    const session: ChatSession = {
      id: activeSessionId,
      title: messages.find((message) => message.role === 'user')?.text.slice(0, 36) || 'New conversation',
      messages: storedMessages,
      activities,
      approvals,
      updatedAt: Date.now(),
    };
    const updated = [session, ...sessions.filter((item) => item.id !== activeSessionId)]
      .sort((a, b) => b.updatedAt - a.updatedAt);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions: updated, activeSessionId }))
      .catch(() => undefined);
  }, [messages, activities, approvals, hydrated, activeSessionId, sessions]);

  const newChat = () => {
    abortRef.current?.();
    setSessions((current) => [{
      id: activeSessionId,
      title: messages.find((message) => message.role === 'user')?.text.slice(0, 36) || 'New conversation',
      messages,
      activities,
      approvals,
      updatedAt: Date.now(),
    }, ...current.filter((session) => session.id !== activeSessionId)]);
    setMessages([]);
    setActivities([]);
    setApprovals([]);
    setAttachments([]);
    setActiveSessionId(uid());
  };

  const openSession = (session: ChatSession) => {
    abortRef.current?.();
    setSessions((current) => [{
      id: activeSessionId,
      title: messages.find((message) => message.role === 'user')?.text.slice(0, 36) || 'New conversation',
      messages,
      activities,
      approvals,
      updatedAt: Date.now(),
    }, ...current.filter((item) => item.id !== activeSessionId)]);
    setActiveSessionId(session.id);
    setMessages(session.messages);
    setActivities(session.activities);
    setApprovals(session.approvals);
    setAttachments([]);
  };

  const deleteSession = async (id: string) => {
    const updated = sessions.filter((session) => session.id !== id);
    setSessions(updated);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions: updated, activeSessionId }));
    if (id === activeSessionId) newChat();
  };

  const resolveApproval = async (id: string, status: 'approved' | 'cancelled') => {
    const approval = approvals.find((item) => item.id === id);
    let label = 'Action cancelled';
    let toolOutput: Record<string, unknown> = { cancelled: status === 'cancelled' };
    if (status === 'approved' && approval?.name === 'create_reminder') {
      const title = String(approval.arguments.title ?? 'Tdotbot reminder');
      const date = new Date(String(approval.arguments.when_iso ?? ''));
      if (!isFutureDate(date)) {
        Alert.alert('Invalid reminder time', 'Ask Tdotbot again with a specific future date and time.');
        return;
      }
      const permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Notifications disabled', 'Enable notifications to schedule reminders.');
        return;
      }
      await Notifications.scheduleNotificationAsync({
        content: { title: 'Tdotbot reminder', body: title, sound: true },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date },
      });
      label = `Reminder scheduled for ${date.toLocaleString()}`;
      toolOutput = { success: true, title, scheduled_for: date.toISOString() };
    } else if (status === 'approved' && approval?.name === 'get_current_location') {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Location permission denied');
        return;
      }
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      label = `Location: ${location.coords.latitude.toFixed(5)}, ${location.coords.longitude.toFixed(5)}`;
      toolOutput = { latitude: location.coords.latitude, longitude: location.coords.longitude, accuracy_meters: location.coords.accuracy };
    } else if (status === 'approved' && approval?.name === 'find_contact') {
      const permission = await Contacts.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Contacts permission denied');
        return;
      }
      const query = String(approval.arguments.query ?? '');
      const result = await Contacts.getContactsAsync({
        name: query,
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
        pageSize: 5,
      });
      label = result.data.length
        ? `Contacts: ${result.data.map((contact) => contact.name).join(', ')}`
        : `No contact found for “${query}”`;
      toolOutput = {
        query,
        contacts: result.data.map((contact) => ({
          name: contact.name,
          phone_numbers: contact.phoneNumbers?.map((phone) => phone.number).filter(Boolean) ?? [],
          emails: contact.emails?.map((email) => email.email).filter(Boolean) ?? [],
        })),
      };
    } else if (status === 'approved' && approval?.name === 'create_calendar_event') {
      const title = String(approval.arguments.title ?? 'Tdotbot event');
      const startDate = new Date(String(approval.arguments.start_iso ?? ''));
      const endDate = new Date(String(approval.arguments.end_iso ?? ''));
      if (!isFutureDate(startDate) || endDate <= startDate) {
        Alert.alert('Invalid event time');
        return;
      }
      await Calendar.createEventInCalendarAsync({ title, startDate, endDate });
      label = `Opened calendar confirmation for ${title}`;
      toolOutput = { confirmation_ui_opened: true, title, start: startDate.toISOString(), end: endDate.toISOString() };
    } else if (status === 'approved' && approval?.name === 'compose_email') {
      const to = String(approval.arguments.to ?? '');
      const subject = String(approval.arguments.subject ?? '');
      const body = String(approval.arguments.body ?? '');
      await Linking.openURL(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
      label = `Opened an email draft to ${to}`;
      toolOutput = { success: true, draft_opened: true, to, subject };
    } else if (status === 'approved' && approval?.name === 'compose_sms') {
      const phone = String(approval.arguments.phone ?? '');
      const message = String(approval.arguments.message ?? '');
      const separator = Platform.OS === 'ios' ? '&' : '?';
      await Linking.openURL(`sms:${encodeURIComponent(phone)}${separator}body=${encodeURIComponent(message)}`);
      label = `Opened an SMS draft to ${phone}`;
      toolOutput = { success: true, draft_opened: true, phone };
    } else if (status === 'approved' && approval?.name === 'call_phone') {
      const phone = String(approval.arguments.phone ?? '');
      await Linking.openURL(`tel:${encodeURIComponent(phone)}`);
      label = `Opened the phone dialer for ${phone}`;
      toolOutput = { success: true, dialer_opened: true, phone };
    } else if (status === 'approved' && approval?.name === 'open_map') {
      const query = String(approval.arguments.query ?? '');
      await Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`);
      label = `Opened maps for ${query}`;
      toolOutput = { success: true, maps_opened: true, query };
    } else if (status === 'approved' && approval?.name === 'open_url') {
      const url = String(approval.arguments.url ?? '');
      if (!/^https?:\/\//i.test(url)) {
        Alert.alert('Invalid link', 'Only HTTP and HTTPS links can be opened.');
        return;
      }
      await Linking.openURL(url);
      label = `Opened ${url}`;
      toolOutput = { success: true, opened: true, url };
    } else if (status === 'approved' && approval?.name === 'share_text') {
      const text = String(approval.arguments.text ?? '');
      await Share.share({ message: text });
      label = 'Opened the system share sheet';
      toolOutput = { success: true, share_sheet_opened: true };
    } else if (status === 'approved' && approval?.name === 'save_note') {
      const title = String(approval.arguments.title ?? 'Note');
      const body = String(approval.arguments.body ?? '');
      const existing = JSON.parse((await AsyncStorage.getItem(NOTES_KEY)) ?? '[]') as Record<string, unknown>[];
      await AsyncStorage.setItem(NOTES_KEY, JSON.stringify([{ id: uid(), title, body }, ...existing].slice(0, 100)));
      label = `Saved note: ${title}`;
      toolOutput = { success: true, title };
    } else if (status === 'approved' && approval?.name === 'create_contact') {
      const permission = await Contacts.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Contacts permission denied');
        return;
      }
      const name = String(approval.arguments.name ?? 'New contact');
      const phone = String(approval.arguments.phone ?? '');
      const email = String(approval.arguments.email ?? '');
      const contactId = await Contacts.addContactAsync({
        contactType: Contacts.ContactTypes.Person,
        name,
        firstName: name,
        phoneNumbers: phone ? [{ label: 'mobile', number: phone }] : [],
        emails: email ? [{ label: 'home', email }] : [],
      });
      label = `Created contact: ${name}`;
      toolOutput = { success: true, contact_id: contactId, name };
    } else if (status === 'approved') {
      label = 'Action approved';
    }
    setApprovals((current) => current.map((item) => item.id === id ? { ...item, status } : item));
    const activity: AgentActivity = {
      id: uid(),
      label,
      status: 'complete',
    };
    setActivities((current) => [activity, ...current].slice(0, 8));
    if (approval?.responseId) {
      const assistant: ChatMessage = { id: uid(), role: 'assistant', text: '' };
      setMessages((current) => [...current, assistant]);
      setBusy(true);
      try {
        await continueTool(approval.responseId, approval.id, toolOutput, (delta) => {
          setMessages((current) => current.map((message) => message.id === assistant.id
            ? { ...message, text: message.text + delta }
            : message));
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Tool continuation failed.';
        setMessages((current) => current.map((message) => message.id === assistant.id
          ? { ...message, text: `The device action finished, but I could not continue: ${detail}` }
          : message));
      } finally {
        setBusy(false);
      }
    }
  };

  const addImage = async (camera: boolean) => {
    if (camera) {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Camera permission required');
        return;
      }
    }
    const result = camera
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], base64: true, quality: 0.7 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.7 });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset.base64) return;
    const mimeType = asset.mimeType ?? 'image/jpeg';
    setAttachments((current) => [...current, {
      id: uid(),
      name: asset.fileName ?? 'photo.jpg',
      mimeType,
      kind: 'image',
      dataUrl: `data:${mimeType};base64,${asset.base64}`,
      previewUri: asset.uri,
    }]);
  };

  const addDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled) return;
    const asset = result.assets[0];
    if ((asset.size ?? 0) > 10 * 1024 * 1024) {
      Alert.alert('File too large', 'Choose a file under 10 MB.');
      return;
    }
    const file = new File(asset.uri);
    const mimeType = asset.mimeType ?? file.type ?? 'application/octet-stream';
    const base64 = await file.base64();
    setAttachments((current) => [...current, {
      id: uid(),
      name: asset.name,
      mimeType,
      kind: mimeType.startsWith('image/') ? 'image' : 'file',
      dataUrl: `data:${mimeType};base64,${base64}`,
      previewUri: mimeType.startsWith('image/') ? asset.uri : undefined,
    }]);
  };

  const send = async (preset?: string) => {
    const text = (preset ?? draft).trim();
    if (!text || busy) return;

    const user: ChatMessage = { id: uid(), role: 'user', text, attachments };
    const assistant: ChatMessage = { id: uid(), role: 'assistant', text: '' };
    const next = [...messages, user];
    setMessages([...next, assistant]);
    setDraft('');
    setAttachments([]);
    setBusy(true);

    const request = streamChat(next, (delta) => {
      setMessages((current) => current.map((message) =>
        message.id === assistant.id ? { ...message, text: message.text + delta } : message,
      ));
    }, (event) => {
      if (event.type === 'activity') {
        setActivities((current) => {
          const matching = current.findIndex((item) => item.label === event.label && item.agent === event.agent);
          if (matching >= 0) {
            return current.map((item, index) => index === matching ? { ...item, status: event.status } : item);
          }
          return [{ id: uid(), agent: event.agent, label: event.label, status: event.status }, ...current].slice(0, 12);
        });
      }
      if (event.type === 'approval') {
        setApprovals((current) => [{ ...event, status: 'pending' }, ...current]);
      }
    });
    abortRef.current = request.abort;

    try {
      await request.promise;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      setMessages((current) => current.map((item) =>
        item.id === assistant.id ? { ...item, text: `Sorry — ${message}` } : item,
      ));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const runFromAgentHub = (prompt: string) => {
    setActiveView('chat');
    setTimeout(() => send(prompt), 0);
  };

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.screen}
      >
        <View style={[styles.header, compact && styles.headerCompact]}>
          <View style={styles.brandMark}><Text style={styles.brandGlyph}>O</Text></View>
          <Text style={styles.brand}>Tdotbot</Text>
          <View style={styles.viewSwitcher}>
            <Pressable onPress={() => setActiveView('chat')} style={[styles.viewButton, activeView === 'chat' && styles.viewButtonActive]}><Text style={[styles.viewButtonText, activeView === 'chat' && styles.viewButtonTextActive]}>Chat</Text></Pressable>
            <Pressable onPress={() => setActiveView('agent')} style={[styles.viewButton, activeView === 'agent' && styles.viewButtonActive]}><Text style={[styles.viewButtonText, activeView === 'agent' && styles.viewButtonTextActive]}>Agent</Text></Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start a new chat"
            onPress={newChat}
            style={styles.newButton}
          >
            <Text style={styles.newButtonText}>New</Text>
          </Pressable>
        </View>

        {activeView === 'agent' ? (
          <AgentWorkspaceHub onRunAgent={runFromAgentHub} />
        ) : <>
        {!!visibleSessions.length && (
          <ScrollView style={styles.sessionScroller} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sessionStrip}>
            {visibleSessions.map((session) => (
              <Pressable
                key={session.id}
                onLongPress={() => deleteSession(session.id)}
                onPress={() => openSession(session)}
                style={[styles.sessionChip, session.id === activeSessionId && styles.sessionChipActive]}
              >
                <Text numberOfLines={1} style={styles.sessionText}>{session.title}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {!hydrated ? (
          <View style={styles.loading}><ActivityIndicator color="#8ef0cb" /></View>
        ) : messages.length === 0 ? (
          <ScrollView
            style={styles.main}
            contentContainerStyle={[styles.empty, compact && styles.emptyCompact]}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.eyebrow}>OPENAI COMPANION</Text>
            <Text style={styles.title}>What can I help{`\n`}you make happen?</Text>
            <Text style={styles.subtitle}>Ask naturally. Tdotbot keeps the answer focused and useful.</Text>
            <View style={[styles.starters, compact && styles.startersCompact]}>
              {starters.map((starter) => (
                <Pressable key={starter} onPress={() => send(starter)} style={styles.starter}>
                  <Text style={styles.starterText}>{starter}</Text>
                  <Text style={styles.arrow}>↗</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : (
          <FlatList
            style={styles.main}
            contentContainerStyle={styles.list}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={[styles.message, item.role === 'user' ? styles.userMessage : styles.assistantMessage]}>
                <Text style={[styles.messageLabel, item.role === 'user' && styles.userLabel]}>
                  {item.role === 'user' ? 'YOU' : 'TDOTBOT'}
                </Text>
                {item.text ? (
                  <Text style={[styles.messageText, item.role === 'user' && styles.userText]}>{item.text}</Text>
                ) : <ActivityIndicator color="#8ef0cb" />}
                {!!item.attachments?.length && (
                  <View style={styles.messageAttachments}>
                    {item.attachments.map((attachment) => attachment.previewUri ? (
                      <Image key={attachment.id} source={{ uri: attachment.previewUri }} style={styles.messageImage} />
                    ) : <Text key={attachment.id} style={styles.messageFile}>📄 {attachment.name}</Text>)}
                  </View>
                )}
              </View>
            )}
          />
        )}

        <View style={[styles.agentPanel, compact && styles.agentPanelCompact]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={agentPanelOpen ? 'Collapse agent activity' : 'Expand agent activity'}
            onPress={() => setAgentPanelOpen((open) => !open)}
            style={styles.agentHeader}
          >
            <Text style={styles.agentTitle}>TDOTBOT AGENT</Text>
            <Text style={styles.agentToggle}>{agentPanelOpen ? 'Hide' : 'Show'}</Text>
          </Pressable>
          {agentPanelOpen && (
            <ScrollView nestedScrollEnabled showsVerticalScrollIndicator contentContainerStyle={styles.agentContent}>
              <View style={styles.activityRow}>
                {busy ? <ActivityIndicator size="small" color="#8ef0cb" /> : <Text style={styles.readyDot}>●</Text>}
                <Text style={styles.activityText}>{busy ? 'Coordinator and specialists are working' : 'Coordinator + 3 specialists ready'}</Text>
              </View>
            {approvals.slice(0, 2).map((approval) => (
              <View key={approval.id} style={styles.approvalCard}>
                <Text style={styles.approvalName}>Approval needed: {approval.name.replaceAll('_', ' ')}</Text>
                <Text numberOfLines={2} style={styles.approvalDetail}>{JSON.stringify(approval.arguments)}</Text>
                {approval.status === 'pending' ? (
                  <View style={styles.approvalActions}>
                    <Pressable onPress={() => resolveApproval(approval.id, 'cancelled')} style={styles.cancelAction}>
                      <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                    <Pressable onPress={() => resolveApproval(approval.id, 'approved')} style={styles.approveAction}>
                      <Text style={styles.approveText}>Approve</Text>
                    </Pressable>
                  </View>
                ) : <Text style={styles.resolvedText}>{approval.status.toUpperCase()}</Text>}
              </View>
            ))}
            {activities.slice(0, 3).map((activity) => (
              <View key={activity.id} style={styles.activityRow}>
                {activity.status === 'running' ? <ActivityIndicator size="small" color="#8ef0cb" /> : <Text style={styles.check}>✓</Text>}
                <View style={styles.activityCopy}>
                  {!!activity.agent && <Text style={styles.activityAgent}>{activity.agent}</Text>}
                  <Text style={styles.activityText}>{activity.label}</Text>
                </View>
              </View>
            ))}
              {!activities.length && !approvals.length && (
                <Text style={styles.agentHint}>Tools: web, Python, reminders, calendar, contacts, location, maps, calls, SMS, email, sharing, links, files, photos, and private notes. Device actions require approval.</Text>
              )}
            </ScrollView>
          )}
        </View>

        <View style={styles.composerShell}>
          {!!attachments.length && (
            <View style={styles.attachmentTray}>
              {attachments.map((attachment) => (
                <Pressable key={attachment.id} onPress={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))} style={styles.attachmentChip}>
                  <Text numberOfLines={1} style={styles.attachmentText}>{attachment.kind === 'image' ? '🖼️' : '📄'} {attachment.name}</Text>
                  <Text style={styles.removeAttachment}>×</Text>
                </Pressable>
              ))}
            </View>
          )}
          <View style={styles.composer}>
            <Pressable accessibilityLabel="Attach a photo" onPress={() => addImage(false)} style={styles.attachButton}>
              <Text style={styles.attachIcon}>▧</Text>
            </Pressable>
            <Pressable accessibilityLabel="Take a photo" onPress={() => addImage(true)} style={styles.attachButton}>
              <Text style={styles.attachIcon}>◉</Text>
            </Pressable>
            <Pressable accessibilityLabel="Attach a document" onPress={addDocument} style={styles.attachButton}>
              <Text style={styles.attachIcon}>＋</Text>
            </Pressable>
            <TextInput
              multiline
              onChangeText={setDraft}
              onSubmitEditing={() => send()}
              placeholder="Message Tdotbot"
              placeholderTextColor="#7e8795"
              returnKeyType="send"
              style={styles.input}
              value={draft}
            />
            {busy ? (
              <Pressable onPress={() => abortRef.current?.()} style={styles.stopButton}>
                <View style={styles.stopIcon} />
              </Pressable>
            ) : (
              <Pressable disabled={!canSend} onPress={() => send()} style={[styles.sendButton, !canSend && styles.sendDisabled]}>
                <Text style={styles.sendText}>↑</Text>
              </Pressable>
            )}
          </View>
          <Text style={styles.disclaimer}>AI can make mistakes. Check important information.</Text>
        </View>
        </>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#090d13' },
  screen: { flex: 1, minHeight: 0 },
  main: { flex: 1, minHeight: 0 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { height: 68, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#1b222d' },
  headerCompact: { height: 54, paddingHorizontal: 14 },
  brandMark: { width: 30, height: 30, borderRadius: 10, backgroundColor: '#8ef0cb', alignItems: 'center', justifyContent: 'center' },
  brandGlyph: { color: '#07120e', fontWeight: '900' },
  brand: { color: '#f5f7fa', fontSize: 18, fontWeight: '700', marginLeft: 10, flex: 1 },
  viewSwitcher: { flexDirection: 'row', backgroundColor: '#111820', borderRadius: 12, padding: 3, marginRight: 8 },
  viewButton: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 9 },
  viewButtonActive: { backgroundColor: '#24303b' },
  viewButtonText: { color: '#6f7b8b', fontSize: 11, fontWeight: '800' },
  viewButtonTextActive: { color: '#8ef0cb' },
  sessionScroller: { flexGrow: 0, flexShrink: 0 },
  sessionStrip: { paddingHorizontal: 14, paddingVertical: 8, gap: 8 },
  sessionChip: { maxWidth: 170, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: '#141b24', borderWidth: 1, borderColor: '#202a36' },
  sessionChipActive: { borderColor: '#8ef0cb' },
  sessionText: { color: '#c7d0db', fontSize: 12 },
  newButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: '#171e27' },
  newButtonText: { color: '#dbe1e9', fontSize: 13, fontWeight: '600' },
  empty: { flexGrow: 1, paddingHorizontal: 24, paddingVertical: 22, justifyContent: 'center' },
  emptyCompact: { justifyContent: 'flex-start', paddingHorizontal: 18, paddingVertical: 16 },
  eyebrow: { color: '#8ef0cb', fontSize: 12, letterSpacing: 2, fontWeight: '800', marginBottom: 15 },
  title: { color: '#f4f6f9', fontSize: 38, lineHeight: 43, fontWeight: '800', letterSpacing: -1.5 },
  subtitle: { color: '#929cab', fontSize: 16, lineHeight: 24, marginTop: 14, maxWidth: 330 },
  starters: { marginTop: 34, gap: 10 },
  startersCompact: { marginTop: 20 },
  starter: { borderRadius: 16, borderWidth: 1, borderColor: '#242d39', backgroundColor: '#111720', paddingHorizontal: 17, paddingVertical: 15, flexDirection: 'row', alignItems: 'center' },
  starterText: { color: '#dce2e9', fontSize: 15, flex: 1 },
  arrow: { color: '#8ef0cb', fontSize: 18 },
  list: { padding: 18, gap: 12 },
  message: { borderRadius: 20, padding: 16, maxWidth: '92%' },
  userMessage: { backgroundColor: '#c8f7e5', alignSelf: 'flex-end', borderBottomRightRadius: 6 },
  assistantMessage: { backgroundColor: '#151c25', alignSelf: 'flex-start', borderBottomLeftRadius: 6, borderWidth: 1, borderColor: '#202a36' },
  messageLabel: { color: '#8ef0cb', fontSize: 10, letterSpacing: 1.4, fontWeight: '800', marginBottom: 7 },
  userLabel: { color: '#27604d' },
  messageText: { color: '#eef2f6', fontSize: 16, lineHeight: 24 },
  userText: { color: '#10261e' },
  messageAttachments: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  messageImage: { width: 120, height: 90, borderRadius: 10 },
  messageFile: { color: '#496353', backgroundColor: '#dcfbed', padding: 8, borderRadius: 8, fontSize: 12 },
  composerShell: { flexShrink: 0, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8, borderTopWidth: 1, borderTopColor: '#161d26' },
  composer: { minHeight: 58, maxHeight: 150, flexDirection: 'row', alignItems: 'flex-end', backgroundColor: '#151c25', borderRadius: 22, borderWidth: 1, borderColor: '#2b3542', paddingLeft: 16, paddingRight: 8, paddingVertical: 8 },
  attachmentTray: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 8 },
  attachmentChip: { maxWidth: 220, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#202a35', borderRadius: 11, paddingHorizontal: 10, paddingVertical: 7 },
  attachmentText: { color: '#d5dce5', fontSize: 12, flexShrink: 1 },
  removeAttachment: { color: '#8ef0cb', fontSize: 16 },
  attachButton: { width: 30, height: 40, alignItems: 'center', justifyContent: 'center' },
  attachIcon: { color: '#9aa6b5', fontSize: 19 },
  input: { flex: 1, color: '#f1f4f7', fontSize: 16, lineHeight: 22, minHeight: 40, paddingTop: 9, paddingBottom: 8 },
  sendButton: { width: 40, height: 40, borderRadius: 15, backgroundColor: '#8ef0cb', alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  sendDisabled: { opacity: 0.25 },
  sendText: { color: '#07120e', fontSize: 23, fontWeight: '900', marginTop: -2 },
  stopButton: { width: 40, height: 40, borderRadius: 15, backgroundColor: '#313b48', alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  stopIcon: { width: 12, height: 12, borderRadius: 2, backgroundColor: '#f5f7fa' },
  disclaimer: { color: '#5f6977', fontSize: 10, textAlign: 'center', marginTop: 8 },
  agentPanel: { flexShrink: 1, marginHorizontal: 14, marginTop: 8, padding: 12, borderRadius: 16, backgroundColor: '#101720', borderWidth: 1, borderColor: '#202b37', maxHeight: 190 },
  agentPanelCompact: { maxHeight: 130, marginTop: 6, paddingVertical: 9 },
  agentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  agentContent: { paddingTop: 4, paddingBottom: 2 },
  agentTitle: { color: '#8ef0cb', fontSize: 10, letterSpacing: 1.4, fontWeight: '800' },
  agentToggle: { color: '#8995a4', fontSize: 11, fontWeight: '700', paddingVertical: 3, paddingLeft: 12 },
  readyDot: { color: '#8ef0cb', fontSize: 10 },
  agentHint: { color: '#738091', fontSize: 11, lineHeight: 16, marginTop: 7 },
  activityRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  activityCopy: { flex: 1 },
  activityAgent: { color: '#8ef0cb', fontSize: 10, fontWeight: '800', marginBottom: 1 },
  activityText: { color: '#aeb7c3', fontSize: 12, flex: 1 },
  check: { color: '#8ef0cb', fontWeight: '800' },
  approvalCard: { backgroundColor: '#18212b', borderRadius: 12, padding: 11, marginBottom: 8 },
  approvalName: { color: '#f2f5f8', fontWeight: '700', fontSize: 13 },
  approvalDetail: { color: '#8995a4', fontSize: 11, marginTop: 4 },
  approvalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  cancelAction: { paddingHorizontal: 12, paddingVertical: 7 },
  cancelText: { color: '#aeb7c3', fontWeight: '600' },
  approveAction: { backgroundColor: '#8ef0cb', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  approveText: { color: '#07120e', fontWeight: '800' },
  resolvedText: { color: '#8ef0cb', fontSize: 10, fontWeight: '800', marginTop: 8 },
});

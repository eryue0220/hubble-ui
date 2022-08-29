import { configure, reaction, autorun, toJS, makeAutoObservable } from 'mobx';

import { Flow } from '~/domain/flows';
import { Filters, FilterEntry } from '~/domain/filtering';

import { Service } from '~/domain/service-map';
import { StateChange } from '~/domain/misc';
import { setupDebugProp } from '~/domain/misc';
import { HubbleService, HubbleLink, HubbleFlow } from '~/domain/hubble';
import { FeatureFlags } from '~/domain/features';

import {
  ServiceMapPlacementStrategy,
  ServiceMapArrowStrategy,
} from '~/domain/layout/service-map';

import RouteStore, { RouteHistorySourceKind } from './route';
import ControlStore from './controls';
import FeaturesStore from './features';

import { StoreFrame, EventKind as FrameEvent } from '~/store/frame';
import * as storage from '~/storage/local';

configure({ enforceActions: 'observed' });

export interface Props {
  historySource: RouteHistorySourceKind;
}

export type FlushOptions = {
  namespaces?: boolean;
  policies?: boolean;
  globalFrame?: boolean;
};

export class Store {
  public route: RouteStore;

  public controls: ControlStore;

  public placement: ServiceMapPlacementStrategy;

  public arrows: ServiceMapArrowStrategy;

  public globalFrame: StoreFrame;

  public currentFrame: StoreFrame;

  public features: FeaturesStore;

  private afterResetCallbacks: Array<() => void> = [];

  constructor(props: Props) {
    makeAutoObservable(this, void 0, { autoBind: true });

    this.controls = new ControlStore();
    this.route = new RouteStore(props.historySource);
    this.features = new FeaturesStore();

    this.globalFrame = StoreFrame.emptyWithShared(this.controls);
    this.currentFrame = StoreFrame.emptyWithShared(this.controls);

    this.placement = new ServiceMapPlacementStrategy(this.currentFrame);
    this.arrows = new ServiceMapArrowStrategy(
      this.currentFrame,
      this.placement,
    );

    this.restoreNamespace();
    this.restoreVisualFilters();

    // NOTE: main frame should be initialized with all filters set up
    // this.createMainFrame();
    this.setupEventHandlers();
    this.setupReactions();
    this.setupDebugTools();
  }

  setup({
    services,
    flows,
    links,
  }: {
    services: HubbleService[];
    flows: HubbleFlow[];
    links: HubbleLink[];
  }) {
    this.currentFrame.services.set(services);
    this.currentFrame.services.extractAccessPoints(links);
    this.currentFrame.interactions.addHubbleLinks(links);
    this.currentFrame.interactions.setHubbleFlows(flows, { sort: true });
  }

  setNamespaces(nss: Array<string>) {
    this.controls.namespaces = nss;

    if (!this.route.namespace && nss.length > 0) {
      this.controls.setCurrentNamespace(nss[0]);
    }
  }

  resetCurrentFrame(filters: Filters) {
    this.currentFrame.flush();
    this.placement.reset();
    this.arrows.reset();
    this.currentFrame.applyFrame(this.globalFrame, filters);

    this.runAfterResetCallbacks();
  }

  applyServiceChange(svc: Service, change: StateChange) {
    this.currentFrame.applyServiceChange(svc, change);
  }

  applyServiceLinkChange(hubbleLink: HubbleLink, change: StateChange) {
    this.currentFrame.applyServiceLinkChange(hubbleLink, change);
  }

  applyNamespaceChange(ns: string, change: StateChange) {
    if (change === StateChange.Deleted) {
      this.controls.removeNamespace(ns);
      return;
    }

    this.controls.addNamespace(ns);
  }

  addFlows(flows: Flow[]) {
    return this.currentFrame.addFlows(flows);
  }

  public runAfterFrameReset(cb: () => void) {
    this.afterResetCallbacks.push(cb);
  }

  private runAfterResetCallbacks() {
    const n = this.afterResetCallbacks.length;
    const cbs = this.afterResetCallbacks.splice(0, n);

    cbs.forEach(cb => {
      cb();
    });
  }

  get mocked(): boolean {
    return this.route.hash === 'mock';
  }

  public get filters(): Filters {
    return this.controls.filters;
  }

  public flush(opts?: FlushOptions) {
    this.controls.selectTableFlow(null);

    if (!!opts?.globalFrame) {
      this.globalFrame.flush();
    }

    this.currentFrame.flush();
    this.placement.reset();
  }

  private setupEventHandlers() {
    const wrongChanges = [StateChange.Unknown, StateChange.Deleted];

    this.currentFrame.on(FrameEvent.ServicesSet, svcs => {
      this.globalFrame.setServices(svcs);
    });

    this.currentFrame.on(FrameEvent.FlowsAdded, flows => {
      this.globalFrame.addFlows(flows);
    });

    this.currentFrame.on(FrameEvent.LinkChanged, (link, change) => {
      if (wrongChanges.includes(change)) return;

      this.globalFrame.applyServiceLinkChange(link, change);
    });

    this.currentFrame.on(FrameEvent.ServiceChange, (svc, change) => {
      if (wrongChanges.includes(change)) return;

      this.globalFrame.applyServiceChange(svc, change);
    });
  }

  private setupReactions() {
    // initial autoruns fires only once
    autorun(reaction => {
      this.controls.setVerdict(this.route.verdict);
      reaction.dispose();
    });

    autorun(reaction => {
      this.controls.setHttpStatus(this.route.httpStatus);
      reaction.dispose();
    });

    autorun(reaction => {
      this.setFlowFilters(this.route.flowFilters);
      reaction.dispose();
    });

    reaction(
      () => this.controls.currentNamespace,
      namespace => {
        if (!namespace) return;
        this.route.setNamespace(namespace);
      },
    );

    reaction(
      () => this.controls.verdict,
      verdict => {
        this.route.setVerdict(verdict);
      },
    );

    reaction(
      () => this.controls.httpStatus,
      httpStatus => {
        this.route.setHttpStatus(httpStatus);
      },
    );

    reaction(
      () => this.controls.flowFilters,
      filters => this.route.setFlowFilters(filters.map(f => f.toString())),
    );

    // try to update active card flows filter with card caption
    autorun(() => {
      const activeFilter = this.controls.activeCardFilter;
      if (activeFilter == null) {
        this.currentFrame.services.clearActive();
        return;
      }

      if (!activeFilter.isDNS && !activeFilter.isIdentity) return;

      // meta is set already
      if (activeFilter.meta) return;

      // TODO: ensure that query always contains serviceId
      const serviceId = activeFilter.query;
      const card = this.currentFrame.getServiceById(serviceId);
      if (card == null) return; // card is not loaded yet

      this.setFlowFilters(this.controls.flowFilters);
      this.currentFrame.setActiveService(serviceId);
    });
  }

  public toggleActiveService(id: string) {
    return this.currentFrame.toggleActiveService(id);
  }

  public setActiveServiceState(id: string, state: boolean) {
    this.currentFrame.services.setActiveState(id, state);
  }

  public setFlowFiltersForActiveCard(serviceId: string, isActive: boolean) {
    if (!isActive) {
      return this.setFlowFilters([]);
    }

    const card = this.currentFrame.services.byId(serviceId);
    if (card == null) return;

    this.setFlowFilters([card.filterEntry]);
  }

  public setFlowFilters(filters: FilterEntry[]) {
    const nextFilters: FilterEntry[] = [];

    filters.forEach(filter => {
      if (filter.isTCPFlag) return;

      const requiresMeta = filter.isIdentity || filter.isDNS;
      if (!requiresMeta) {
        nextFilters.push(filter);
        return;
      }

      // TODO: change search by card `id` to explicit `identity`
      // when `identity` field is available in grpc schema.
      // For now we use identity for `id` - so it works
      const card = this.currentFrame.services.byId(filter.query);
      if (card != null) {
        filter = filter.clone().setMeta(card.caption);
      }

      nextFilters.push(filter);
    });

    this.controls.setFlowFilters(nextFilters);
  }

  public toggleShowKubeDns(): boolean {
    const isActive = this.controls.toggleShowKubeDns();

    storage.saveShowKubeDns(isActive);
    return isActive;
  }

  public toggleShowHost(): boolean {
    const isActive = this.controls.toggleShowHost();

    storage.saveShowHost(isActive);
    return isActive;
  }

  public toggleShowRemoteNode(): boolean {
    const isActive = this.controls.toggleShowRemoteNode();

    storage.saveShowRemoteNode(isActive);
    return isActive;
  }

  public toggleShowPrometheusApp(): boolean {
    const isActive = this.controls.toggleShowPrometheusApp();

    storage.saveShowPrometheusApp(isActive);
    return isActive;
  }

  public toggleShowKubeApiServer(): boolean {
    const isActive = this.controls.toggleShowKubeApiServer();

    storage.saveShowKubeApiServer(isActive);
    return isActive;
  }

  public setFeatures(features: FeatureFlags) {
    console.log(`setting features`);
    this.features.set(features);
  }

  // D E B U G

  public setupDebugTools() {
    setupDebugProp({
      printMapData: () => {
        this.printMapData();
      },
      printLayoutData: () => {
        this.printLayoutData();
      },
      mobxToJs: (obj: any) => toJS(obj),
    });
  }

  private restoreNamespace() {
    if (!this.route.namespace) return;

    this.controls.setCurrentNamespace(this.route.namespace);
  }

  private restoreVisualFilters() {
    this.controls.setShowHost(storage.getShowHost());
    this.controls.setShowKubeDns(storage.getShowKubeDns());
    this.controls.setShowRemoteNode(storage.getShowRemoteNode());
    this.controls.setShowKubeApiServer(storage.getShowKubeApiServer());
    this.controls.setShowPrometheusApp(storage.getShowPrometheusApp());
  }

  private printMapData() {
    const data = {
      services: this.currentFrame.services.cardsList.map(c => c.service),
      links: this.currentFrame.interactions.links.map(l => l.hubbleLink),
    };

    console.log(JSON.stringify(data, null, 2));
  }

  private printLayoutData() {
    const data = {
      cardsBBoxes: this.placement.cardsBBoxes,
      accessPointCoords: this.placement.accessPointCoords,
      arrows: this.arrows.arrowsMap,
      connections: this.currentFrame.interactions.connections,
    };

    console.log(JSON.stringify(data, null, 2));
    console.log(data);
  }
}

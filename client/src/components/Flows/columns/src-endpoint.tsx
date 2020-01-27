// Copyright 2019 Authors of Hubble
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import * as React from "react";
import { TableCellProps, TableHeaderProps } from "react-virtualized";
import { COLUMN_TITLE } from "./types";
import { cellRenderer, headerRenderer } from "./utils";

const css = require("../FlowsTable.scss");

export const header = (
  props: TableHeaderProps,
  resize: (dataKey: string, deltaX: number) => void
) => {
  return headerRenderer({
    title: COLUMN_TITLE.SRC_ENDPOINT,
    props,
    resize,
    isLast: false
  });
};

export const cell = (props: TableCellProps) => {
  return cellRenderer({
    props,
    renderer: flow => (
      <>
        <span className={css.endpointName}>
          {flow.sourceElement.endpoint.title}
        </span>
        {flow.sourceElement.endpoint.subtitle && (
          <span className={css.endpointNameExtra}>
            {flow.sourceElement.endpoint.subtitle}
          </span>
        )}
      </>
    )
  });
};
